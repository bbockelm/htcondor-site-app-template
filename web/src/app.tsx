// Word Frequency: drop text files, get a count of the words in each.
//
// One HTCondor job per file. The submit sequence in `startOne()` is the
// shape worth preserving from the template -- submit, then upload, then
// let the queue be the record -- because the ordering is not obvious
// and getting it wrong looks like a job that hangs.

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  JobStatus,
  isActive,
  isFinished,
  jobStatusLabel,
  type Job,
} from './lib/api';
import { BATCH_NAME, buildSubmitFile } from './lib/submit';
import {
  CSV_NAME,
  DEFAULT_OPTIONS,
  INPUT_NAME,
  PROGRAM_NAME,
  buildProgram,
  type CountOptions,
} from './lib/wordfreq';
import { app, type Identity } from './lib/htcondor';
import { Dropzone } from './components/Dropzone';
import { Results } from './components/Results';

/**
 * Bigger than this and the upload is the slow part, not the counting.
 * Rejecting it here with a number the user can check beats a transfer
 * that fails twenty minutes in.
 */
const MAX_BYTES = 200 * 1024 * 1024;

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<CountOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, []);

  // Only this app's jobs. The queue is the record -- there is no local
  // database to drift out of sync with it, and a reload loses nothing.
  const refresh = useCallback(async () => {
    try {
      setJobs(await api.jobs(`JobBatchName == "${BATCH_NAME}"`));
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

  /** Submit one file, then send it. Returns the job id. */
  async function startOne(file: File): Promise<string> {
    // 1. Create the job. The server applies this site's submit policy,
    //    so there is no log location or accounting group here.
    const { job_ids } = await api.submit(buildSubmitFile(file.name, file.size));
    const jobId = job_ids[0];
    if (!jobId) throw new Error('The access point accepted the job but did not say which one.');

    // 2. Send the inputs, AFTER submitting: they belong to a job that
    //    exists. Until this finishes the job is transferring input and
    //    looks, to a user, like nothing is happening -- which is why
    //    the button says what it is doing rather than just spinning.
    //
    //    The counting program travels with the text as an ordinary
    //    input file; it is read by awk, never executed, so it does not
    //    need the 0755 the `executable` field would give it.
    const program = buildProgram(file.name, options);
    await api.uploadInputs(jobId, [
      { name: INPUT_NAME, file },
      { name: PROGRAM_NAME, file: new File([program], PROGRAM_NAME, { type: 'text/plain' }) },
    ]);

    return jobId;
  }

  async function run() {
    setBusy(true);
    setError(null);
    setSubmitted(null);
    const started: string[] = [];
    try {
      for (const [i, file] of files.entries()) {
        setProgress(`Sending ${file.name} (${i + 1} of ${files.length})…`);
        started.push(await startOne(file));
      }
      setSubmitted(started.length);
      setFiles([]);
      await refresh();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        started.length
          ? `${detail} — ${started.length} of ${files.length} file(s) were sent and are listed below; the rest were not.`
          : detail,
      );
      if (started.length) await refresh();
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  /** Run a one-click action on a job and show the list again. */
  async function act(pending: Promise<unknown>) {
    try {
      await pending;
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const tooBig = files.filter((f) => f.size > MAX_BYTES);
  const empty = files.filter((f) => f.size === 0);
  const blocked = tooBig.length > 0 || empty.length > 0;

  return (
    <main>
      <h1>{app.name}</h1>
      <p className="lede">
        Drop in some text files and this counts the words in each one.{' '}
        {me?.authenticated ? `Signed in as ${me.username}.` : 'Loading…'}
      </p>

      {error && (
        <div className="notice error" role="alert" data-testid="error">
          {error}
        </div>
      )}
      {submitted !== null && (
        <div className="notice success" role="status" data-testid="submitted">
          Sent {submitted} file{submitted === 1 ? '' : 's'} off to be counted. They are listed
          below and will update by themselves.
        </div>
      )}

      <fieldset>
        <legend>Text files</legend>
        <Dropzone
          files={files}
          onChange={setFiles}
          disabled={busy}
          accept=".txt,.text,.md,text/plain"
          hint="Drop plain text files here, or choose files"
        />
        {tooBig.length > 0 && (
          <p className="notice error" role="alert">
            {tooBig.map((f) => f.name).join(', ')}{' '}
            {tooBig.length === 1 ? 'is' : 'are'} larger than 200 MB. Remove{' '}
            {tooBig.length === 1 ? 'it' : 'them'}, or split the text into smaller files.
          </p>
        )}
        {empty.length > 0 && (
          <p className="notice error" role="alert">
            {empty.map((f) => f.name).join(', ')} {empty.length === 1 ? 'is' : 'are'} empty. Remove{' '}
            {empty.length === 1 ? 'it' : 'them'} and try again.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>How to count</legend>

        <label className="check">
          <input
            type="checkbox"
            checked={options.skipCommonWords}
            disabled={busy}
            data-testid="skip-common"
            onChange={(e) => setOptions({ ...options, skipCommonWords: e.target.checked })}
          />
          <span>Ignore very common words like “the”, “and” and “of”</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={options.foldCase}
            disabled={busy}
            data-testid="fold-case"
            onChange={(e) => setOptions({ ...options, foldCase: e.target.checked })}
          />
          <span>Count “The” and “the” as the same word</span>
        </label>

        <label>
          <span>Ignore words shorter than</span>
          <input
            type="number"
            min={1}
            max={20}
            value={options.minLength}
            disabled={busy}
            data-testid="min-length"
            onChange={(e) => setOptions({ ...options, minLength: Number(e.target.value) })}
          />
        </label>

        <label>
          <span>Show this many of the most frequent words</span>
          <input
            type="number"
            min={1}
            max={500}
            value={options.topN}
            disabled={busy}
            data-testid="top-n"
            onChange={(e) => setOptions({ ...options, topN: Number(e.target.value) })}
          />
        </label>

        <p className="meta">
          Every word is counted either way — these only change what the summary shows. The full
          table of every word is always available to download.
        </p>
      </fieldset>

      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || files.length === 0 || blocked}
        data-testid="submit"
      >
        {busy
          ? (progress ?? 'Sending…')
          : files.length === 0
            ? 'Add a file to begin'
            : `Count the words in ${files.length} file${files.length === 1 ? '' : 's'}`}
      </button>

      <h2>Your files</h2>
      {jobs.length === 0 ? (
        <p className="meta">Nothing counted yet. Drop a text file above to start.</p>
      ) : (
        <ul className="jobs" data-testid="job-list">
          {jobs.map((j) => {
            const id = `${j.ClusterId}.${j.ProcId}`;
            const name = typeof j.WordFreqFile === 'string' ? j.WordFreqFile : `File ${id}`;
            const done = isFinished(j);
            return (
              <li key={id}>
                <div className="row">
                  <span className="name">
                    {name} <span className="meta">#{id}</span>
                  </span>
                  <span className="meta" data-testid="job-status">
                    {jobStatusLabel(j)}
                  </span>
                  {done && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setOpen(open === id ? null : id)}
                    >
                      {open === id ? 'Hide' : 'Show results'}
                    </button>
                  )}
                  {done && (
                    // The CSV, not the JSON: this link is for someone
                    // who wants every word in a spreadsheet, and the
                    // JSON is already on screen as the table.
                    <a href={api.fileUrl(id, CSV_NAME)} download={`${name}.csv`}>
                      Download every word (CSV)
                    </a>
                  )}
                  {isActive(j) && (
                    // "Stop", not "Cancel": this holds the job, which
                    // leaves it in the queue where it can be released.
                    // DELETE /jobs/{id} answers 501, so a Cancel button
                    // would be a control that cannot work.
                    <button type="button" className="secondary" onClick={() => void act(api.hold(id))}>
                      Stop
                    </button>
                  )}
                  {j.JobStatus === JobStatus.Held && (
                    <button type="button" className="secondary" onClick={() => void act(api.release(id))}>
                      Try again
                    </button>
                  )}
                </div>
                {open === id && <Results jobId={id} />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
