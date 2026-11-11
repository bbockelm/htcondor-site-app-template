# Word Frequency

A job submission interface for counting words, served by our HTCondor access point to our group.

Drop in one or more plain text files. Each one becomes one HTCondor job that counts how often every word appears in it. The page lists the jobs, says in words what each is doing, and shows the summary inline when it is done — no submit file, no job id, no tar to unpack.

Built from the [HTCondor site app template](https://github.com/bbockelm/htcondor-site-app-template).

```
make dev      # dev server on :5173, proxying to an API server
make check    # lint, typecheck, test, build
make bundle   # dist/<name>.zip + .sha256 — the thing you deploy
make e2e      # the real API server in Docker, driven through a browser
```

## What the job actually does

`web/src/lib/wordfreq.ts` generates a small **awk** program and `web/src/lib/submit.ts` builds the submit file that runs it. Per file, the job:

1. splits the text into words — runs of letters, apostrophes kept inside them;
2. applies the four options the page offers (fold case, minimum length, skip common words, how many to show);
3. writes three things: a readable summary to stdout, the counts as **`results.json`**, and the full table of every word to `word-counts.csv`.

The page draws a **sortable table** from `results.json`. The prose summary is kept behind a toggle, because it is what people paste into an email, but it is not the default view: parsing formatted text to get numbers the job already knew is work nobody should do twice.

`results.json` needs no JSON escaper inside the awk program, and that is on purpose. The tokenizer admits only `[A-Za-z']`, so a word can never contain a quote, a backslash or a control character; the one value that can — the file's name — is encoded with `JSON.stringify` in TypeScript and embedded already-escaped. There is a test that feeds the counter nothing but dangerous characters and asserts no word needs escaping.

### Declared output files are created before any work

`transfer_output_files` names `results.json` and `word-counts.csv`, and the job's first act is `: > results.json; : > word-counts.csv`. HTCondor **holds** a job whose declared output file is missing at the end, so a file that turns out not to be text would otherwise be held for "missing output" — a state this interface cannot explain to the person who dropped it. `OUTPUT_FILES` is the single list both the declaration and the creation come from, and a test runs the real counter and asserts every declared file exists afterwards.

awk rather than Python: it is on every Linux execute node, and a Python version would be a bet on `python3` and a particular minor version. It is POSIX awk — no `gensub`, no `asort`, no `IGNORECASE` — because the node may have mawk or busybox awk.

The unit tests in `web/src/lib/wordfreq.test.ts` **run the generated program under a real awk** and check the counts. That is the only part of this repository that can be verified without a schedd; see the warning below.

### The user's text never reaches the submit file

The file is uploaded under a fixed name and the options live inside the awk program, so `arguments` and `transfer_input_files` are the same bytes for every job. The only thing a user controls that reaches a submit command is the file's *name*, recorded once as `+WordFreqFile` so the job list can name it after a reload, and it goes through `adString()` and then `quote()` — in that order, because macro expansion happens before the ClassAd is parsed.

## Known problems with the toolchain

**`make e2e` does not work.** The image the template pins, `ghcr.io/bbockelm/golang-htcondor:latest`, rejects the `--demo-credentials-file` flag `scripts/e2e.sh` passes it, and if you remove that flag `--demo` still fails with `condor_master not found in PATH` — the image contains the API server and no HTCondor. So nothing in this repository has been tested against a real schedd, including the submit file. Treat the submit file as unverified until someone runs it against an access point.

`/openapi.json` is now committed at the repo root by the template, which is how the endpoints here were checked. `make openapi` refreshes it from a running server — which, per the above, we do not have.

## What you are building

A **site app** is static files — HTML, CSS and JavaScript — served by the access point's own API server, under `/site/<id>/`, to the groups an operator names. Because it is served from the same origin as the API, the user's existing session cookie is already there: your app calls `/api/v1/...` and is authenticated. There is no login to build, no token to store, no OAuth client to register.

You get the queue, the submit path, file transfer, job output and the rest of the API. You bring the interface and the knowledge of what your lab actually runs.

## Getting started

1. **Use this template**, then clone your copy.
2. Edit `app.yaml` — the name and description your users see.
3. Edit `web/src/lib/wordfreq.ts` and `web/src/lib/submit.ts` — these are the files that are about the science. Everything else is scaffolding.
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
scp dist/wordfreq-app.zip dist/wordfreq-app.zip.sha256 ap.example.edu:/etc/condor/webapps/
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
| `web/src/lib/wordfreq.ts` | Generates the awk word counter. **The science lives here.** |
| `web/src/lib/submit.ts` | Builds the submit file around it. |
| `web/src/lib/api.ts` | Typed API client. Extend it rather than calling `fetch` directly. |
| `web/src/lib/htcondor.ts` | Mount point and identity, from the server. |
| `web/src/app.tsx` | The page: drop files, set options, watch, read results. |
| `web/src/components/Results.tsx` | The summary, fetched from the job's stdout. |
| `e2e/` | Playwright, against a real server. |
| `AGENTS.md` | Read before writing code, by a person or an assistant. |
