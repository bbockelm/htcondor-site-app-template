# Working on this app

This is a **site app** for an HTCondor access point: a static web app served by the access point's API server, to a named group of users, from a zip bundle an operator drops in place.

Read this before writing code. Most of what follows is not guessable from the source.

**How to use this file.** The rules below are mostly scar tissue — each one is a mistake somebody already made, with the reason it was not obvious. When you hit a problem this file does not name, the shape of an answer is usually one of:

- *Can the server tell me, instead of me guessing?* `openapi.json` is committed at the repo root; `GET /api/v1/auth/me` reports who the user is and what they can see.
- *Can I move the cost somewhere cheaper?* The shared-input section below is the worked example: the same data, uploaded once by a DAG instead of once per job.
- *Can I make the failure explain itself?* Creating output files up front, naming a hold in words, showing the server's own error text — all of these turn "it broke" into something the user can act on.
- *Has somebody already solved this here?* Two complete apps live on the `example/word-frequency` and `example/blast` branches. `git diff main..example/blast -- web/src` is often faster than reasoning from first principles — the BLAST one in particular works through a large shared input end to end.

If you solve something this file does not cover, add it here. The next person is in your position with less time.

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

**A large shared input is uploaded once per job. There is no shared stage.** This is the decision that determines whether your app costs a gigabyte or a hundred, so make it deliberately.

The API offers exactly two ways to get a file to a job: `POST /jobs`, which takes a submit file and nothing else, and `POST /jobs/{id}/input/multipart`, which uploads into **one job's** sandbox — the path is a `cluster.proc`, not a cluster. Nothing stores a file once and hands back a name many jobs can use. So a reference input — a BLAST database, a genome, an atlas, model weights — travels once for every job that needs it, out of the user's uplink and into the access point's spool.

What follows from that:

- **Make the job count a budget, not just a parallelism choice.** `jobs × databaseSize` is what the user uploads. Cap the fan-out by the size of the shared input, and refuse sizes that would be absurd.
- **Tell the user the number before they commit to it.** "Your database (480 MB) is sent once per job, so this uploads 1.9 GB" is the cost of the design, and they are the one paying it.
- **`queue N` does not rescue you.** The submit file is one text shared by every proc, but uploads are per `cluster.proc`, so one `transfer_input_files` line cannot name a different per-task input for each proc. A fan-out app submits one cluster per task group. Reach for `queue N` only when every proc genuinely wants the same inputs.
- **A DAG uploads the shared input once.** This is the trick worth knowing. A DAG is submitted as a single job whose spooled sandbox holds everything the workflow needs — the `.dag` file, the per-node submit files, and the shared input. That sandbox goes up **once**. DAGMan then runs on the access point, in that directory, and submits the node jobs itself; each node names the shared file by its basename and it is already there. The user's uplink carries it one time instead of N, and the access point keeps one copy rather than N. The access point still sends it on to each execute node, but that leg is inside the facility and not the one the user waits on.

  Two constraints that shape the design: the spool is **one flat directory**, so every file is referenced by basename and two inputs cannot share a name; and **nothing can be added after submission**, so everything the workflow will ever need goes up in that one upload.

  The catch today: **there is no REST route for submitting a DAG.** `submit_dag` exists as an MCP tool, and `GET /jobs/{id}/dag` reads a submitted workflow's structure back, but a site app cannot submit one. If your app needs this shape, say so — it is the strongest argument for adding the endpoint.

- **A URL in `transfer_input_files` would fix this** — the execute node fetches it, once per node rather than once per job, and a site cache can dedupe it entirely. The submit file is passed through verbatim, so you *can* emit one. But nothing here tells you whether this pool's execute nodes have a working transfer plugin for your scheme, and there is no API that reports it. A control that either works or holds every job with a transfer error, with no way to check first, is worse than the upload. **Ask your access point's operator**, and only then.

**Submit, then upload — and the job is HELD until you do.** The server submits with input spooling on, so between `POST /jobs` and the upload every job sits held under `HoldReasonCode 16` (`SpoolingInput`). That is normal. If your interface renders Held as "stopped" or "failed", it says so about every job the moment the user submits it, which is the first thing they will ever see. `jobStatusLabel` names this case, and `HoldReasonCode` is in `JOB_ATTRS` so it can. `POST /api/v1/jobs` creates the job; `POST /api/v1/jobs/{id}/input/multipart` sends its input files afterwards. Between the two the job sits in a transferring-input state that users read as "stuck". Do not reorder these, and do surface that state as something other than silence.

**`batch_name`, not `JobBatchName = ...`.** A submit file is not a ClassAd. An assignment to a name that is not a submit command defines a submit *macro* and sets nothing on the job, so `JobBatchName = x` leaves the job ad without a `JobBatchName` — and an app that finds its own jobs with a `JobBatchName == ...` constraint then shows an empty list forever, with no error anywhere to say why. The submit command is `batch_name`. A custom attribute needs a leading `+`: `+MyThing = "x"`, and the value must be a ClassAd string *literal*, quotes included. Escape it for the ClassAd grammar first and for macro expansion second, because macro expansion happens before the ClassAd is parsed.

**A result that is a PICTURE goes back as an `<img src>`, not as a fetch.** The obvious way — fetch the bytes, `URL.createObjectURL`, point an `<img>` at the `blob:` URL — is blocked by `default-src 'self'`, because `blob:` is not `'self'`. Nothing throws; the image is simply absent, and it works in `make dev` where there is no CSP. `GET /jobs/{id}/files/{filename}` is same-origin and sets `Content-Type` from the file's own bytes, so an `<img src>` pointing straight at it works, carries the session cookie, streams, and costs the page nothing even for a large image.

  And the pre-create rule above has a consequence here that is worth saying out loud: a job that failed still brings back a **zero-byte** `preview.png`, because every declared output is created empty up front. An `<img>` pointed at zero bytes renders a broken-image icon, which a user reads as "this app is broken" rather than "this job failed". So decide whether a picture exists from the job's `results.json`, never from whether the file exists.

**There is no way to remove a job, and that shapes the error path.** `DELETE /jobs/{id}` answers 501, and holding an already-held job does nothing. So if `POST /jobs` succeeds and the input upload that must follow it fails — a dropped connection half way through a 300 MB file — the job that was created sits held under `SpoolingInput` forever, visible to the user, and no API call the app can make will clear it. Say so in the error, and name the job id, so the user can ask an administrator to `condor_rm` it. Pretending it is not there is worse.

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

**`make e2e` does not run, against any published image.** `scripts/e2e.sh` passes `--demo-credentials-file`. `latest` and every `vN.N.N` tag of `ghcr.io/bbockelm/golang-htcondor` reject that flag outright, and the container exits before the script's own "an older server may predate it" guard can fire — so the error you get is `container exited early`, which points at the wrong thing. `devel` accepts the flag and then fails with `Demo mode failed: condor_master not found in PATH`: every one of these images is an Alpine layer containing the Go binary and nothing else, so `--demo` ("run in demo mode with mini condor") has no mini condor to run.

  The default here is `devel`, because its failure at least names the real problem. Until an image ships with HTCondor in it, **the advice elsewhere in this file that `submit.ts` changes "always need `make e2e`" cannot be followed**, and the e2e job in `.github/workflows/ci.yml` is red on every commit. What stands in for it here: `web/src/lib/runner.test.ts` runs `python3` over every generated job program, and the Python was additionally run by hand against astropy and real multi-extension FITS files — which is how the primary-header bug in `header_summary` was found. Neither substitutes for a real schedd accepting the submit file.

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
