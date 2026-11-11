# Working on this app

This is a **site app** for an HTCondor access point: a static web app served by the access point's API server, to a named group of users, from a zip bundle an operator drops in place.

Read this before writing code. Most of what follows is not guessable from the source.

## The API

The app talks to the HTCondor HTTP API at `/api/v1/*` on its own origin.

**Do not invent endpoints.** The API is larger than `web/src/lib/api.ts` and not larger in the way you are about to assume. Check `openapi.json` in this repository before adding a call — it is a copy of the spec the server serves at `/openapi.json`, committed here so you can read it without a running server. A plausible-looking REST route that does not exist is the single most common failure in this codebase.

**Some documented routes are not implemented.** Read each description, not just the path: `DELETE /jobs/{id}` and `PATCH /jobs/{id}` are both in the spec and both answer `501`, and the words "NOT YET IMPLEMENTED" are the only warning. To stop a job, hold it (`POST /jobs/{id}/hold`); call it "stop", not "cancel", because a held job is still in the queue and can be released.

The endpoints this app uses are wrapped in `web/src/lib/api.ts`. Add to that file rather than calling `fetch` from a component.

**Authentication is already done.** The app is served same-origin, so the browser holds the session cookie the user got when they logged in. Every request sends `credentials: 'include'` and that is the whole story. There is no token to store, no refresh, no Authorization header, no login form to build. A 401 means the session expired; `api.ts` redirects to `/login` for you.

**Ask for every job attribute you read.** `GET /jobs` has a default projection — `ClusterId, ProcId, Owner, JobStatus, Cmd, Args` — and returns nothing else. A field you did not request arrives `undefined`, and that does not fail loudly, it *renders*: a finished job whose `ExitCode` was never asked for displays as "Failed (exit undefined)". `JOB_ATTRS` in `api.ts` is the list; add to it before you read a new attribute anywhere. `limit` likewise defaults to 50 and truncates in silence.

**Have the job write JSON, not just prose.** A page handed `{"rows": [...]}` can draw a table, sort it, show the top ten. A page handed a block of text can only put it in a `<pre>` and hope. The job is the only thing that knows the shape of its own results, so emit them structured there — one `printf` — and keep the human-readable text as well.

**Create every declared output file at the START of the job.** HTCondor *holds* a job whose declared output file is missing when it finishes, so a job that writes `results.json` only on success is held on every failure — and held for a transfer error, which says nothing about what actually went wrong. `: > results.json` before any real work costs nothing and lets failures report themselves. `buildSubmitFile` does this from `OUTPUT_FILES`, and a test fails if it stops.

The specifics, from the HTCondor source rather than from memory:

- **The hold is `HoldReasonCode = 13`** (`UploadFileError`), and the reason text is the transfer error, e.g. `Error from slot1@node: error reading from /path/results.json: ...`. It names a file-transfer problem, never the thing your job actually got wrong.
- **One missing file loses the whole set.** The upload returns on the first file it cannot read, so the other declared outputs do not come back either. Pre-create *all* of them, which is why `OUTPUT_FILES` is one list feeding both the declaration and the `: >` lines.
- **`when_to_transfer_output = ON_EXIT` still transfers after a non-zero exit.** The starter transfers whenever the job ran to completion on its own; it skips transfer only when the job was told to exit (evicted or removed). So pre-creating the files genuinely protects the failure path — if it did not, this rule would buy nothing where it matters most.

**Keep the structured file small enough to render.** It is what the *page* draws, not an archive. If your results can run to thousands of rows, put the top N in the JSON and the full set in a CSV the user downloads — a browser handed 600 KB of JSON to turn into a table will show it, slowly, and nobody thanks you. The example emits two fields, so it never meets this question; yours will.

**Submit, then upload.** `POST /api/v1/jobs` creates the job; `POST /api/v1/jobs/{id}/input/multipart` sends its input files afterwards. Between the two the job sits in a transferring-input state that users read as "stuck". Do not reorder these, and do surface that state as something other than silence.

**Do not set site policy in the submit file.** The server applies this access point's own defaults and overrides — a required log location, an accounting group, a concurrency limit — to everything this app submits. Writing them here is at best redundant and at worst fights the operator.

## Platform constraints

These are properties of the server, not preferences. Violating one produces a page that works in `make dev` and breaks when deployed.

- **`Content-Security-Policy: default-src 'self'`.** No CDN scripts, no Google Fonts, no external images, no `eval`. Vendor everything into `web/src/`. A dependency that injects a remote script at runtime will not work.
- **Build with a relative base.** `base: './'` in `web/vite.config.ts`. Never hardcode `/site/<id>/`: the app's id is the bundle's file name, which the operator chooses and may change to stage a new version.
- **Read `window.__HTCONDOR_APP__.base` for routing**, via `web/src/lib/htcondor.ts`. Do not infer the mount point from `location.pathname` — it is wrong exactly when the user reloads on a sub-route.
- **`app.yaml` must not contain a `groups` key.** Who may see this app is the operator's decision, recorded in a separate file next to the deployed bundle. A `groups` key in the bundle is ignored, and writing one suggests otherwise to the next reader.
- **Nothing in this repository is secret.** The bundle is static files served to every member of its groups. An API key, a password or a token committed here is disclosed to all of them. If the app needs a credential, it belongs in the job, obtained through the credential endpoints — not in the bundle.

## Who uses this

Domain experts who are not computing experts. They are not adversaries and they are not fools; they simply did not come here to learn about batch systems.

- Prefer one obvious control over three flexible ones. If a knob has a right answer for this lab, set it in code and do not show it.
- **Never surface a raw submit file, a ClassAd expression, a `HoldReasonCode` or a bare exit status.** Translate. `jobStatusLabel` in `api.ts` is the pattern: say what happened in words, and prefer being specific about the common case over being accurate about all of them.
- An error message must say what to do next. "Submission failed" is not an error message. The API's own messages are written to be read by the person who hit them — surface them rather than replacing them with your own.
- Jobs wait. A queued job is normal, not broken, and the interface should say which it is without being asked.

## The loop

```
make check    # lint, typecheck, unit tests, build — run before claiming anything works
make e2e      # real server in Docker; run for anything touching submission
make bundle   # the deliverable: dist/<app>.zip plus its sha256
```

`make check` is what CI runs first, so a failure here is a failure there.

Changes to `web/src/lib/submit.ts` always need `make e2e`. The unit tests check the submit file's text; only a real schedd tells you whether it is a submit file it will accept.

**Do not add a dependency without saying why in the commit message.** Every one of them ships to users inside the bundle and has to satisfy the CSP.

## Shape of the repository

```
app.yaml              name and description. No groups, no id.
Makefile              make help
web/src/lib/htcondor.ts   where am I, who is looking (platform integration)
web/src/lib/api.ts        typed API client — extend this, don't bypass it
web/src/lib/submit.ts     builds the submit file; THIS is your science
web/src/app.tsx           the demo flow, meant to be replaced
e2e/                      playwright against a real server
scripts/e2e.sh            starts the server, deploys the bundle, runs the suite
```

`web/src/lib/submit.ts` is the file that is actually about this lab's work. The quoting helpers in it are not decoration: `$` in a submit file is a macro substitution, and `$ENV(...)` reads the *server's* environment, so a file name a user typed must be escaped before it goes anywhere near a submit command.
