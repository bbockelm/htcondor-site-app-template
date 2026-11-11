// FITS Previews: drop Hubble frames, get statistics and a picture back.
//
// The submit sequence in `run()` is the part worth reading. It is:
//
//   for each job:  POST /jobs  ->  POST /jobs/{id}/input/multipart
//
// in that order, one job at a time, because:
//
//   * the upload needs a job to upload INTO, so submit comes first;
//   * between the two the job is HELD under HoldReasonCode 16, which
//     is normal and which the status label says in words;
//   * the files here are hundreds of megabytes, so the uploads go one
//     after another rather than all at once. Twenty parallel uploads
//     through one uplink finish no sooner and make the progress
//     meaningless.
//
// The consequence of all that, which the interface has to be honest
// about: a submission of twenty frames is twenty sequential uploads,
// and if the tab is closed half way through, the jobs already created
// but not yet fed sit held forever. Nothing in this API can remove
// them -- DELETE /jobs/{id} answers 501 -- so the app says so rather
// than pretending.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  isFinished,
  isReceivingFiles,
  jobStatusLabel,
  JobStatus,
  type Job,
} from './lib/api';
import {
  CHANNELS,
  CLIPS,
  DEFAULT_OPTIONS,
  SIZES,
  STRETCHES,
  formatBytes,
  isSafeFileName,
  looksLikeFits,
  plan,
  planSentence,
  type Channel,
  type Options,
} from './lib/fits';
import { buildRunner, runnerConfig, RUNNER_FILE, type RunnerImage } from './lib/runner';
import { BATCH_PREFIX, batchNameFor, buildSubmitFile } from './lib/submit';
import { app, type Identity } from './lib/htcondor';
import { Dropzone } from './components/Dropzone';
import { Results } from './components/Results';

/** The runner is the same text for every job; build it per submission. */
function runnerFile(text: string): File {
  return new File([text], RUNNER_FILE, { type: 'text/x-python' });
}

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS);
  const [channels, setChannels] = useState<Record<string, Channel>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, []);

  // The queue is the record. This app keeps no database of its own, so
  // everything it knows about past runs it reads back from the schedd.
  const refresh = useCallback(async () => {
    try {
      let found: Job[];
      try {
        found = await api.jobs(`regexp("^${BATCH_PREFIX}", JobBatchName)`);
      } catch (e) {
        // A server that will not evaluate this constraint is not a
        // reason to show the user nothing. Ask for all of theirs and
        // filter here.
        if (!(e instanceof ApiError) || e.status >= 500) throw e;
        found = await api.jobs();
      }
      setJobs(found.filter((j) => String(j.JobBatchName ?? '').startsWith(BATCH_PREFIX)));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Default channel assignment: in file order, and with two frames the
  // outer two colours, because green is synthesised from them.
  useEffect(() => {
    setChannels((current) => {
      const next: Record<string, Channel> = {};
      const defaults: Channel[] = files.length === 2 ? ['red', 'blue'] : [...CHANNELS];
      files.slice(0, CHANNELS.length).forEach((f, i) => {
        next[f.name] = current[f.name] ?? defaults[i] ?? 'red';
      });
      return next;
    });
  }, [files]);

  const planned = useMemo(
    () => plan(opts, files.map((f) => ({ name: f.name, bytes: f.size }))),
    [opts, files],
  );

  const duplicateChannels =
    opts.mode === 'composite' &&
    new Set(files.map((f) => channels[f.name])).size !== files.length;

  const blocker =
    planned.blocker ??
    (duplicateChannels ? 'Each image needs a different colour. Change one of them.' : null);

  const ready = files.length > 0 && !blocker && !busy;

  async function run() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress(null);

    const batchName = batchNameFor(opts.mode);
    const groups: { images: RunnerImage[]; files: File[]; title: string }[] =
      opts.mode === 'composite'
        ? [
            {
              images: files.map((f) => ({
                file: f.name,
                label: f.name,
                channel: channels[f.name] ?? 'red',
              })),
              files: [...files],
              title: `Colour composite of ${files.length} filters`,
            },
          ]
        : files.map((f) => ({
            images: [{ file: f.name, label: f.name }],
            files: [f],
            title: f.name,
          }));

    let started = 0;
    let stranded: string | null = null;

    try {
      for (const group of groups) {
        setProgress(
          `Uploading ${started + 1} of ${groups.length} — ${formatBytes(
            group.files.reduce((n, f) => n + f.size, 0),
          )}`,
        );

        const runner = buildRunner(runnerConfig(opts, group.images));
        const submitFile = buildSubmitFile({
          inputNames: group.images.map((i) => i.file),
          inputBytes: group.files.reduce((n, f) => n + f.size, 0),
          batchName,
          title: group.title,
        });

        // 1. Create the job. It is HELD from here until step 2 lands.
        const { job_ids } = await api.submit(submitFile);
        const jobId = job_ids[0];

        // 2. Feed it. If this throws, the job above exists and will
        //    never run, and nothing in this API can remove it.
        try {
          await api.uploadInputs(jobId, [
            { name: RUNNER_FILE, file: runnerFile(runner) },
            ...group.files.map((f) => ({ name: f.name, file: f })),
          ]);
        } catch (e) {
          stranded = jobId;
          throw e;
        }

        started += 1;
        await refresh();
      }

      setNotice(
        started === 1
          ? 'One job is on its way. It appears below, and the picture shows up there when it finishes.'
          : `${started} jobs are on their way. They appear below as they start.`,
      );
      setFiles([]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const parts = [detail];
      if (started > 0) {
        parts.push(
          `${started} of ${groups.length} ${started === 1 ? 'job was' : 'jobs were'} started and ` +
            `are listed below; the rest were not submitted.`,
        );
      }
      if (stranded) {
        parts.push(
          `Job ${stranded} was created but its image never finished uploading, so it will sit ` +
            `in the list as “Receiving your image” and will never run. This interface cannot ` +
            `remove a job — ask your system administrator to run condor_rm on it.`,
        );
      }
      setError(parts.join(' '));
    } finally {
      setBusy(false);
      setProgress(null);
      void refresh();
    }
  }

  return (
    <main>
      <h1>{app.name}</h1>
      <p className="lede">
        Statistics and a picture for every FITS frame you drop.{' '}
        {me?.authenticated ? `Signed in as ${me.username}.` : ''}
      </p>

      {error && (
        <div className="notice error" role="alert" data-testid="error">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status" data-testid="submitted">
          {notice}
        </div>
      )}

      <fieldset>
        <legend>Images</legend>
        <Dropzone
          files={files}
          onChange={setFiles}
          disabled={busy}
          accept=".fits,.fit,.fts,.fits.gz,.fz,image/fits,application/fits"
          prompt="Drop FITS images here, or choose files"
          fileNote={(f) =>
            !isSafeFileName(f.name)
              ? 'rename: only letters, digits, dot, dash and underscore'
              : !looksLikeFits(f.name)
                ? 'does not look like a FITS file'
                : null
          }
          renderExtra={
            opts.mode === 'composite'
              ? (f) => (
                  <select
                    className="channel"
                    aria-label={`Colour channel for ${f.name}`}
                    value={channels[f.name] ?? 'red'}
                    disabled={busy}
                    onChange={(e) =>
                      setChannels((c) => ({ ...c, [f.name]: e.target.value as Channel }))
                    }
                  >
                    {CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )
              : undefined
          }
        />
      </fieldset>

      <fieldset>
        <legend>What to do with them</legend>

        <label>
          <span>Each image on its own, or one colour picture</span>
          <select
            value={opts.mode}
            disabled={busy}
            data-testid="mode"
            onChange={(e) => setOpts((o) => ({ ...o, mode: e.target.value as Options['mode'] }))}
          >
            <option value="each">
              Look at each image separately — statistics and a grey preview for every frame
            </option>
            <option value="composite">
              Combine filters into one colour picture — two or three frames, one per colour
            </option>
          </select>
        </label>

        {opts.mode === 'composite' && (
          <p className="meta">
            Each filter is scaled on its own, which is what makes a composite look like a colour
            image. The colour is qualitative — it is a picture, not a measurement. The frames must
            already be on the same pixel grid; this app does not reproject.
          </p>
        )}

        <label>
          <span>Stretch — how pixel values become brightness</span>
          <select
            value={opts.stretch}
            disabled={busy}
            data-testid="stretch"
            onChange={(e) =>
              setOpts((o) => ({ ...o, stretch: e.target.value as Options['stretch'] }))
            }
          >
            {STRETCHES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Range — how much of the brightest and faintest to clip</span>
          <select
            value={opts.clip}
            disabled={busy}
            data-testid="clip"
            onChange={(e) => setOpts((o) => ({ ...o, clip: e.target.value as Options['clip'] }))}
          >
            {CLIPS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Preview size — longest side</span>
          <select
            value={opts.size}
            disabled={busy}
            data-testid="size"
            onChange={(e) => setOpts((o) => ({ ...o, size: Number(e.target.value) }))}
          >
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {blocker && (
        <div className="notice error" role="alert" data-testid="blocker">
          {blocker}
        </div>
      )}
      {!blocker &&
        planned.warnings.map((w) => (
          <div className="notice warn" key={w}>
            {w}
          </div>
        ))}

      <p className="meta" data-testid="plan">
        {planSentence(opts, planned)}
      </p>

      <button type="button" onClick={() => void run()} disabled={!ready} data-testid="submit">
        {busy ? (progress ?? 'Submitting…') : opts.mode === 'composite' ? 'Make the picture' : 'Process these images'}
      </button>

      <h2>Your runs</h2>
      {jobs.length === 0 ? (
        <p className="meta">Nothing yet. Submitted runs stay here until the access point ages
          them out of the queue.</p>
      ) : (
        <ul className="jobs" data-testid="job-list">
          {jobs.map((j) => {
            const id = `${j.ClusterId}.${j.ProcId}`;
            const title = String(j.FitsTitle ?? j.JobBatchName ?? 'run');
            const expanded = open === id;
            return (
              <li key={id} className="job">
                <div className="job-row">
                  <span className="name">
                    {title} <span className="meta">#{id}</span>
                  </span>
                  <span className="meta">{jobStatusLabel(j)}</span>

                  {isFinished(j) && (
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : id)}
                    >
                      {expanded ? 'Hide' : 'Show results'}
                    </button>
                  )}

                  {(j.JobStatus === JobStatus.Idle || j.JobStatus === JobStatus.Running) && (
                    // "Stop", not "Cancel": this holds the job, which
                    // leaves it in the queue where it can be released.
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void api.hold(id, 'You stopped this image').then(refresh)}
                    >
                      Stop
                    </button>
                  )}

                  {j.JobStatus === JobStatus.Held && !isReceivingFiles(j) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void api.release(id).then(refresh)}
                    >
                      Try again
                    </button>
                  )}
                </div>
                {expanded && <Results job={j} />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
