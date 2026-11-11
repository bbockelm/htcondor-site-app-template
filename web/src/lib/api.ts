// Typed client for the HTCondor HTTP API.
//
// Three rules, all of which this file already follows for you:
//
//   1. Every request sends `credentials: 'include'`. The app is served
//      from the same origin as the API, so the browser already holds a
//      session cookie; there is no token to manage and no Authorization
//      header to build.
//   2. A 401 means the session expired. Go to /login. Do not try to
//      refresh anything.
//   3. Errors come back as JSON with a `message` or `error` field.
//      Surface that text -- it is written to be read.
//
// Before adding an endpoint here, check /openapi.json on a running
// server. The API is larger than this file; it is not larger than you
// think in the particular way you are about to assume.

import { redirectToLogin, type Identity } from './htcondor';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* not JSON; statusText is the best we have */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The same thing for an endpoint that answers text/plain.
 *
 * `request` assumes JSON, and a few endpoints -- stdout and stderr
 * among them -- do not answer JSON. Calling res.json() on those throws
 * a parse error that reads like a server fault.
 */
async function requestText(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* not JSON; statusText is the best we have */
    }
    throw new ApiError(res.status, detail);
  }
  return res.text();
}

/**
 * The attributes this app reads off a job.
 *
 * This list is the contract with the server: anything not named here
 * comes back undefined, whatever the job actually holds. Keep it in
 * step with what the components read -- a field added to the UI but
 * not to this list fails quietly and looks like a backend bug.
 *
 * Added for this app: WordFreqFile, the name the user gave the file,
 * and ExitBySignal/ExitSignal, which distinguish "the program was
 * killed" from "the program returned an error" -- different sentences
 * for the user.
 */
export const JOB_ATTRS = [
  'ClusterId',
  'ProcId',
  'JobStatus',
  'Owner',
  'Cmd',
  'JobBatchName',
  'QDate',
  'ExitCode',
  'ExitBySignal',
  'ExitSignal',
  'HoldReason',
  'WordFreqFile',
] as const satisfies readonly string[];

/**
 * A job as the API returns it: a ClassAd, so the fields are loose.
 *
 * Which of these are actually populated depends on the `projection`
 * sent with the query -- see JOB_ATTRS above. Most of them are NOT in
 * the server's default projection.
 */
export interface Job {
  ClusterId: number;
  ProcId: number;
  JobStatus: number;
  Owner?: string;
  Cmd?: string;
  JobBatchName?: string;
  QDate?: number;
  HoldReason?: string;
  ExitCode?: number;
  ExitBySignal?: boolean;
  ExitSignal?: number;
  [attr: string]: unknown;
}

export interface SubmitResult {
  cluster_id: number;
  job_ids: string[];
}

/** A file the user dropped, paired with the name the job will see. */
export interface InputFile {
  name: string;
  file: File;
  /** Mode 0755 instead of 0644. One per submission at most. */
  executable?: boolean;
}

export const api = {
  /** Who is logged in. Resolves the session cookie only. */
  me: () => request<Identity>('/auth/me'),

  /**
   * Submit a job.
   *
   * `submitFile` is the text of an HTCondor submit file, ending in a
   * `queue` line. Site-wide policy (a required log location, an
   * accounting group) is applied by the server; you do not need to know
   * what this access point requires.
   */
  submit: (submitFile: string) =>
    request<SubmitResult>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ submit_file: submitFile }),
    }),

  /**
   * Upload input files for a job that has already been submitted.
   *
   * Submit first, upload second: the job sits in a "transferring input"
   * state until this completes, which is why a freshly submitted job
   * can look stuck for a moment. Submit with `hold = true` if the job
   * must not start before its inputs land.
   */
  uploadInputs: async (jobId: string, files: InputFile[]): Promise<void> => {
    const form = new FormData();
    for (const f of files) {
      form.append(f.executable ? 'executable' : 'input', f.file, f.name);
    }
    await request<void>(`/jobs/${encodeURIComponent(jobId)}/input/multipart`, {
      method: 'POST',
      body: form,
    });
  },

  /**
   * The caller's jobs. `constraint` is a ClassAd expression.
   *
   * ALWAYS sends an explicit projection. `GET /jobs` has a default
   * one -- ClusterId, ProcId, Owner, JobStatus, Cmd, Args -- and
   * returns nothing else, so a field you did not ask for arrives
   * `undefined` rather than missing. That is not a loud failure: it
   * renders. A finished job whose ExitCode was never requested reads
   * "Failed (exit undefined)", which is the opposite of the truth.
   *
   * Add an attribute here before you read it anywhere else.
   *
   * `limit` also has a default (50) and truncates silently.
   */
  jobs: (constraint?: string, attrs: readonly string[] = JOB_ATTRS, limit = 200) => {
    const q = new URLSearchParams({ projection: attrs.join(','), limit: String(limit) });
    if (constraint) q.set('constraint', constraint);
    return request<{ jobs: Job[] }>(`/jobs?${q}`).then((r) => r.jobs ?? []);
  },

  job: (jobId: string) => request<Job>(`/jobs/${encodeURIComponent(jobId)}`),

  /**
   * Stop a running or queued job by holding it.
   *
   * NOT `DELETE /jobs/{id}`: that route exists in the API but is
   * documented "NOT YET IMPLEMENTED" and answers 501. A button wired
   * to it cannot work, however reasonable it looks.
   *
   * Holding is not removing, so say "stop", not "cancel" -- a held
   * job is still in the queue and can be released. Calling it
   * "cancelled" in the interface would be the kind of lie AGENTS.md
   * tells you not to tell.
   *
   * The reason is optional in the API and worth sending anyway: it
   * comes back as HoldReason, so the job then reads "Stopped: you
   * stopped this file" instead of a bare "Stopped", and the user can
   * tell their own click apart from the pool holding the job.
   */
  hold: (jobId: string, reason = 'You stopped this file') =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/hold`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Release a held job so it can run again. */
  release: (jobId: string) =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/release`, { method: 'POST' }),

  /** The job's standard output, as text. This is the readable report. */
  stdout: (jobId: string) => requestText(`/jobs/${encodeURIComponent(jobId)}/stdout`),

  /** The job's standard error, as text. Only read when something failed. */
  stderr: (jobId: string) => requestText(`/jobs/${encodeURIComponent(jobId)}/stderr`),

  /** One named file from the job's output sandbox, as text. */
  jobFile: (jobId: string, name: string) =>
    requestText(`/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`),

  /** URL for the job's output sandbox as a tar. Use as an href. */
  outputUrl: (jobId: string) => `${BASE}/jobs/${encodeURIComponent(jobId)}/output`,

  /** URL for one named file from the job's sandbox. Use as an href. */
  fileUrl: (jobId: string, name: string) =>
    `${BASE}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`,

  /**
   * Site submit templates, if this access point defines any. A template
   * is a submit-file body plus the column names it expects.
   *
   * Entirely optional: an app that builds its own submit files never
   * needs to call this.
   */
  templates: () =>
    request<{ templates: { id: string; name: string; description?: string; columns?: string[] }[] }>(
      '/templates',
    ).then((r) => r.templates ?? []),
};

/** JobStatus codes, which the API returns as bare integers. */
export const JobStatus = {
  Idle: 1,
  Running: 2,
  Removed: 3,
  Completed: 4,
  Held: 5,
  Transferring: 6,
  Suspended: 7,
} as const;

/** True while the job is still going to produce something. */
export function isActive(job: Job): boolean {
  return (
    job.JobStatus === JobStatus.Idle ||
    job.JobStatus === JobStatus.Running ||
    job.JobStatus === JobStatus.Transferring ||
    job.JobStatus === JobStatus.Suspended
  );
}

/** True once the job has counted the words and brought the results back. */
export function isFinished(job: Job): boolean {
  return job.JobStatus === JobStatus.Completed && job.ExitCode === 0;
}

/**
 * A label for a job's state, in words the user can act on.
 *
 * Every branch here depends on an attribute that is only present
 * because JOB_ATTRS asked for it. ExitCode in particular: without it
 * the Completed branch reads `undefined` and reports a successful job
 * as "Failed (exit undefined)", which is worse than saying nothing.
 */
export function jobStatusLabel(job: Job): string {
  switch (job.JobStatus) {
    case JobStatus.Idle:
      return job.QDate && Date.now() / 1000 - job.QDate < 30
        ? 'Starting'
        : 'Waiting for a free computer';
    case JobStatus.Running:
      return 'Counting words';
    case JobStatus.Removed:
      return 'Cancelled';
    case JobStatus.Completed:
      if (job.ExitCode === 0) return 'Finished';
      // ExitBySignal means the program was killed rather than exiting,
      // which for this job means it ran out of memory or time far more
      // often than it means a bug. Saying "exit 137" to a linguist is
      // not an error message.
      if (job.ExitBySignal) return 'Stopped by the system before it finished';
      if (typeof job.ExitCode === 'number') return "Didn't finish — see the details";
      return 'Finished, but the result is unclear';
    case JobStatus.Held:
      return job.HoldReason ? `Stopped: ${job.HoldReason}` : 'Stopped';
    case JobStatus.Transferring:
      return 'Copying results back';
    case JobStatus.Suspended:
      return 'Paused by the system';
    default:
      return 'Unknown';
  }
}
