// The app shell: everything that is the same whatever you are running.
//
// Who you are, the dropzone, the submit-then-upload-then-poll
// sequence, the job list, the errors. What is actually being computed
// lives in pipelines/, behind the small interface in pipelines/types.ts.
//
// Three pipelines ship as worked examples. A lab building their own
// deletes the two they do not want and edits the third; nothing on the
// server knows which exist.
//
// The shape worth keeping is the submit sequence in `run()` below --
// submit, then upload, then poll -- because the ordering is not
// obvious and getting it wrong looks like a job that hangs.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, HoldReasonCode, jobStatusLabel, type Job } from './lib/api';
import { PIPELINES, pipelineById } from './pipelines';
import { isPlanError } from './pipelines/types';
import { app, type Identity } from './lib/htcondor';
import { Dropzone } from './components/Dropzone';

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [pipelineId, setPipelineId] = useState(PIPELINES[0].id);
  // Each pipeline keeps its own options; the shell holds them without
  // looking inside, and resets them when the pipeline changes.
  const [options, setOptions] = useState<unknown>(PIPELINES[0].defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ authenticated: false }));
  }, []);

  // Only this app's jobs. The queue is the record -- there is no local
  // database to drift out of sync with it.
  const refresh = useCallback(async () => {
    try {
      const batch = PIPELINES.map((p) => `JobBatchName == "${p.id}"`).join(' || ');
      setJobs(await api.jobs(batch));
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

  const pipeline = pipelineById(pipelineId) ?? PIPELINES[0];

  function choosePipeline(id: string) {
    const next = pipelineById(id);
    if (!next) return;
    setPipelineId(id);
    // Not carried across: one pipeline's options mean nothing to
    // another, and a stale value here would be submitted silently.
    setOptions(next.defaults);
    setFiles([]);
    setError(null);
  }

  async function run() {
    setBusy(true);
    setError(null);
    setSubmitted(null);
    try {
      // The pipeline decides what to submit. It may refuse -- a file
      // it cannot use, a name it cannot safely transfer -- and its
      // message is written for the person who dropped the file.
      const planned = pipeline.plan(files, options);
      if (isPlanError(planned)) {
        setError(planned.message);
        return;
      }

      // 1. Submit. The server applies this site's submit policy, so we
      //    do not set a log location or an accounting group.
      //
      //    A DAG goes to a different endpoint: its shared inputs are
      //    spooled ONCE and DAGMan submits the nodes from that
      //    sandbox. That is the answer to "every job needs the same
      //    2 GB database"; see pipelines/blast.
      let jobId: string;
      if (planned.kind === 'dag') {
        // Everything in one call. A workflow's spool is written once,
        // so a second upload afterwards would not be rejected -- it
        // would be accepted and silently dropped.
        const res = await api.submitDag({
          dag: planned.dagFile,
          files: planned.nodeFiles,
          uploads: planned.uploads,
          batchName: planned.batchName,
        });
        jobId = res.job_id;
      } else {
        jobId = (await api.submit(planned.submitFile)).job_ids[0];
        // 2. Upload, AFTER submitting: the files belong to a job that
        //    exists. Until this finishes the job sits in "transferring
        //    input" and looks, to a user, like nothing is happening.
        if (planned.uploads.length) {
          await api.uploadInputs(jobId, planned.uploads);
        }
      }

      setSubmitted(jobId);
      setFiles([]);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{app.name}</h1>
      <p className="lede">
        {me?.authenticated ? `Signed in as ${me.username}.` : 'Loading…'}
      </p>

      {error && (
        <div className="notice error" role="alert" data-testid="error">
          {error}
        </div>
      )}
      {submitted && (
        <div className="notice success" role="status" data-testid="submitted">
          Submitted job {submitted}. It will appear below.
        </div>
      )}

      <fieldset>
        <legend>Input files</legend>
        <p className="meta">This pipeline takes {pipeline.inputLabel}.</p>
        <Dropzone
          files={files}
          onChange={setFiles}
          disabled={busy}
          accept={pipeline.accept}
          multiple={pipeline.multiple}
        />
      </fieldset>

      <fieldset>
        <legend>Settings</legend>
        <label>
          <span>Pipeline</span>
          <select
            value={pipelineId}
            onChange={(e) => choosePipeline(e.target.value)}
            disabled={busy}
            data-testid="pipeline"
          >
            {PIPELINES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="meta" data-testid="pipeline-summary">
          {pipeline.summary}
        </p>
        {/* Whatever this pipeline asks for. The shell does not know
            what these mean; it hands them back on submit. */}
        <pipeline.Controls options={options} onChange={setOptions} busy={busy} />
      </fieldset>

      <button type="button" onClick={() => void run()} disabled={busy} data-testid="submit">
        {busy ? 'Submitting…' : 'Run pipeline'}
      </button>

      <h2>Your runs</h2>
      {jobs.length === 0 ? (
        <p className="meta">Nothing running yet.</p>
      ) : (
        <ul className="jobs" data-testid="job-list">
          {jobs.map((j) => {
            const id = `${j.ClusterId}.${j.ProcId}`;
            return (
              <li key={id}>
                <span className="name">
                  {String(j.JobBatchName ?? 'run')} <span className="meta">#{id}</span>
                </span>
                <span className="meta">{jobStatusLabel(j)}</span>
                {j.JobStatus === 4 && (
                  <a href={api.outputUrl(id)}>Download results</a>
                )}
                {(j.JobStatus === 1 || j.JobStatus === 2) && (
                  // "Stop", not "Cancel": this holds the job, which
                  // leaves it in the queue where it can be released.
                  // DELETE /jobs/{id} answers 501, so a Cancel button
                  // would be a control that cannot work.
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void api.hold(id).then(refresh)}
                  >
                    Stop
                  </button>
                )}
                {j.JobStatus === 5 && j.HoldReasonCode !== HoldReasonCode.SpoolingInput && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void api.release(id).then(refresh)}
                  >
                    Try again
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
