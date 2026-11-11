// The demo flow. This file is meant to be replaced.
//
// It exists so the repository works the moment you clone it: drop
// files, pick a pipeline, submit, watch. Delete what you do not want
// rather than assembling what you do.
//
// The shape worth keeping is the submit sequence in `run()` below --
// submit, then upload, then poll -- because the ordering is not
// obvious and getting it wrong looks like a job that hangs.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, jobStatusLabel, type Job } from './lib/api';
import { buildSubmitFile } from './lib/submit';
import { app, type Identity } from './lib/htcondor';
import { Dropzone } from './components/Dropzone';

// Replace with your lab's pipelines. These are strings in a submit
// file, not a registry: nothing on the server knows about them.
const PIPELINES = [
  { id: 'align', name: 'Alignment' },
  { id: 'refine', name: 'Refinement' },
  { id: 'classify', name: 'Classification' },
];

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [pipeline, setPipeline] = useState(PIPELINES[0].id);
  const [cpus, setCpus] = useState(1);
  const [memoryMB, setMemoryMB] = useState(2048);
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

  async function run() {
    setBusy(true);
    setError(null);
    setSubmitted(null);
    try {
      // 1. Submit. The server applies this site's submit policy, so we
      //    do not set a log location or an accounting group.
      const submitFile = buildSubmitFile({
        pipeline,
        inputNames: files.map((f) => f.name),
        cpus,
        memoryMB,
      });
      const { job_ids } = await api.submit(submitFile);
      const jobId = job_ids[0];

      // 2. Upload, AFTER submitting: the files belong to a job that
      //    exists. Until this finishes the job sits in "transferring
      //    input" and looks, to a user, like nothing is happening.
      if (files.length) {
        await api.uploadInputs(
          jobId,
          files.map((f) => ({ name: f.name, file: f })),
        );
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
        <Dropzone files={files} onChange={setFiles} disabled={busy} />
      </fieldset>

      <fieldset>
        <legend>Settings</legend>
        <label>
          <span>Pipeline</span>
          <select
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
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
        <label>
          <span>CPU cores</span>
          <input
            type="number"
            min={1}
            max={16}
            value={cpus}
            onChange={(e) => setCpus(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <label>
          <span>Memory (MB)</span>
          <input
            type="number"
            min={128}
            step={128}
            value={memoryMB}
            onChange={(e) => setMemoryMB(Number(e.target.value))}
            disabled={busy}
          />
        </label>
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
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void api.remove(id).then(refresh)}
                  >
                    Cancel
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
