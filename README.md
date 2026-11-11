# HTCondor site app template

A starting point for a custom job submission interface served by an HTCondor access point, to your group, at your site.

Clone it with **Use this template** on GitHub. It already works: drop files, pick a pipeline, submit, watch the jobs run. Delete the parts you do not want rather than assembling the parts you do.

```
make dev      # dev server on :5173, proxying to an API server
make check    # lint, typecheck, test, build
make bundle   # dist/<name>.zip + .sha256 — the thing you deploy
make e2e      # the real API server in Docker, driven through a browser
```

## What you are building

A **site app** is static files — HTML, CSS and JavaScript — served by the access point's own API server, under `/site/<id>/`, to the groups an operator names. Because it is served from the same origin as the API, the user's existing session cookie is already there: your app calls `/api/v1/...` and is authenticated. There is no login to build, no token to store, no OAuth client to register.

You get the queue, the submit path, file transfer, job output and the rest of the API. You bring the interface and the knowledge of what your lab actually runs.

## Getting started

1. **Use this template**, then clone your copy.
2. Edit `app.yaml` — the name and description your users see.
3. Edit `web/src/lib/submit.ts` — this is the file that is about your science. Everything else is scaffolding.
4. Edit `web/src/app.tsx` — the controls. Fewer is better; see `AGENTS.md`.
5. `make check`, then `make bundle`.

Point the dev server at a real API server:

```
make dev API=https://your-access-point.example.edu
```

Or run one locally with `htcondor-api --demo`, which brings up a personal HTCondor and a login you can use.

## Deploying

```
make bundle
scp dist/myapp.zip dist/myapp.zip.sha256 ap.example.edu:/etc/condor/webapps/
```

The bundle's **file name is the app's id**, so `myapp.zip` is served at `/site/myapp/`. Renaming the file deploys the same build as a second, independent app — which is how you stage a new version alongside the running one.

Your operator writes one file beside it, once:

```yaml
# /etc/condor/webapps/myapp.yaml
groups: [smith_lab]    # who may see it. Required; the bundle cannot set this.
home: true             # land these users here instead of the dashboard
enabled: true
```

A bundle with no policy file beside it is not served at all. That is deliberate: who may see your app is the site's decision, never the bundle's, so forgetting the file fails closed rather than publishing your work to the whole pool.

The server notices the new file and reloads it. There is no restart.

`make bundle` is reproducible — the same source produces the same bytes and the same digest — so an operator can rebuild from your tagged commit and confirm that what is deployed is what you shipped.

## Worked examples

Two complete apps, each on its own branch. They are not extra folders to wade through: `main` stays the one thing "Use this template" gives you, and each example is a branch you can **diff against it** to see exactly what building an app involves.

| Branch | What it does | Worth reading for |
| --- | --- | --- |
| [`example/word-frequency`](../../tree/example/word-frequency) | Counts word frequencies in dropped text files, one job per file | A sortable results table drawn from the job's `results.json`, and an awk program generated in the browser so no user text ever reaches the submit file |
| [`example/blast`](../../tree/example/blast) | Searches many query files against one uploaded reference database | What to do when a large input is shared by many jobs — including telling the user what their submission will cost before they press the button |

```bash
git diff main..example/blast -- web/src
```

Both were written from this repository alone, by someone with no other context, which is also how most of its sharper edges were found. Each is pinned to the template as it stood when it was written, so expect small drift from `main`.

## What not to do

The short version of `AGENTS.md`, which you should read before writing code:

- No CDN scripts, fonts or images. The server sends `default-src 'self'` and will block them.
- Never hardcode `/site/myapp/`. Read `window.__HTCONDOR_APP__.base`.
- No `groups` in `app.yaml`. No secrets anywhere in the bundle — it is public to everyone in its groups.
- Do not invent API endpoints. Check `/openapi.json` on a running server.

## Layout

| Path | What it is |
|---|---|
| `app.yaml` | Name and description. Not groups, not id. |
| `web/src/lib/submit.ts` | Builds the submit file. **Your science lives here.** |
| `web/src/lib/api.ts` | Typed API client. Extend it rather than calling `fetch` directly. |
| `web/src/lib/htcondor.ts` | Mount point and identity, from the server. |
| `web/src/app.tsx` | The demo flow. Replace it. |
| `e2e/` | Playwright, against a real server. |
| `AGENTS.md` | Read before writing code, by a person or an assistant. |
