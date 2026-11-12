#!/usr/bin/env bash
# Run the end-to-end suite against a real htcondor-api in demo mode.
#
# Deploys the bundle this repo just built, reads the generated passwords
# out of the demo credentials file, and runs Playwright.
#
# Used by `make e2e` and by CI, so the two cannot drift.
#
# TWO IMAGES, and the reason is not obvious. Demo mode runs a personal
# HTCondor, so it needs condor_master -- and the published API image is
# a minimal one carrying only the Go binary. Running it with --demo
# fails with "condor_master not found in PATH".
#
# So the pool comes from upstream's minicondor image, and the API binary
# is lifted out of the release image and mounted into it. The binary is
# statically linked, so it runs there even though the two images are
# built on different distributions. That beats publishing a second
# multi-gigabyte image whose only job is to hold both halves.
set -euo pipefail

APP="${APP:-$(basename "$PWD")}"
# Where the API binary comes from, and where the pool comes from.
API_IMAGE="${API_IMAGE:-ghcr.io/bbockelm/golang-htcondor:latest}"
POOL_IMAGE="${POOL_IMAGE:-htcondor/mini:latest}"
PORT="${API_PORT:-8443}"
DEMO_CREDS="${DEMO_CREDS:-/tmp/htcondor-demo-credentials.json}"
APPS_DIR="${APPS_DIR:-/etc/condor/webapps}"
NAME="htcondor-api-e2e-$$"

cleanup() {
  # One trap, one function. A second `trap ... EXIT` would REPLACE this
  # one rather than add to it, and the container would be left running.
  [ -z "${BINDIR:-}" ] || rm -rf "$BINDIR"
  if [ -n "${KEEP_CONTAINER:-}" ]; then
    echo "==> leaving $NAME running (KEEP_CONTAINER set)"
    return
  fi
  echo "==> container logs (tail)"
  docker logs --tail 50 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Lift the binary out of the API image. `docker create` makes a
# container without running it, which is the documented way to copy a
# file out of an image that has no shell -- and this one has barely
# anything else either.
echo "==> taking htcondor-api out of $API_IMAGE"
BINDIR="$(mktemp -d)"
cid="$(docker create "$API_IMAGE")"
docker cp "$cid:/usr/local/bin/htcondor-api" "$BINDIR/htcondor-api" >/dev/null
docker rm -f "$cid" >/dev/null
chmod +x "$BINDIR/htcondor-api"

echo "==> starting $POOL_IMAGE with it"
docker run -d --name "$NAME" -p "${PORT}:8443" \
  -v "$BINDIR/htcondor-api:/usr/local/bin/htcondor-api:ro" \
  --entrypoint /usr/local/bin/htcondor-api \
  "$POOL_IMAGE" \
  --demo --listen :8443 --demo-credentials-file "$DEMO_CREDS" >/dev/null

echo "==> waiting for the server"
for _ in $(seq 1 90); do
  if curl -ksf "https://localhost:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  if ! docker ps -q --filter "name=$NAME" | grep -q .; then
    echo "container exited early" >&2
    exit 1
  fi
  sleep 2
done
curl -ksf "https://localhost:${PORT}/healthz" >/dev/null || {
  echo "server never became healthy" >&2
  exit 1
}

# The credentials file is a published contract of -demo, which is why
# this reads a path instead of grepping a banner out of the logs.
echo "==> reading demo credentials from $DEMO_CREDS"
mkdir -p .e2e
docker exec "$NAME" cat "$DEMO_CREDS" > .e2e/credentials.json || {
  echo "no credentials file in the container at $DEMO_CREDS." >&2
  echo "An older server may predate --demo-credentials-file." >&2
  exit 1
}

echo "==> deploying dist/${APP}.zip"
docker exec "$NAME" mkdir -p "$APPS_DIR"
docker cp "dist/${APP}.zip" "$NAME:${APPS_DIR}/${APP}.zip"
docker cp "dist/${APP}.zip.sha256" "$NAME:${APPS_DIR}/${APP}.zip.sha256"

# The policy file is the operator's, so the test writes one too -- the
# bundle deliberately cannot name its own groups. Empty groups here
# means "every authenticated user", which is what a single-tenant demo
# server wants.
docker exec "$NAME" sh -c "cat > ${APPS_DIR}/${APP}.yaml" <<YAML
groups: ["*"]
home: false
enabled: true
YAML

echo "==> running playwright"
DEMO_CREDENTIALS_FILE="$PWD/.e2e/credentials.json" \
APP_ID="$APP" \
PLAYWRIGHT_BASE_URL="https://localhost:${PORT}" \
  npx --prefix web playwright test --config "$PWD/web/playwright.config.ts"
