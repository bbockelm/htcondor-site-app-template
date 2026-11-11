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

/** A job as the API returns it: a ClassAd, so the fields are loose. */
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

  /** The caller's jobs. `constraint` is a ClassAd expression. */
  jobs: (constraint?: string) => {
    const q = constraint ? `?constraint=${encodeURIComponent(constraint)}` : '';
    return request<{ jobs: Job[] }>(`/jobs${q}`).then((r) => r.jobs ?? []);
  },

  job: (jobId: string) => request<Job>(`/jobs/${encodeURIComponent(jobId)}`),

  remove: (jobId: string) =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),

  /** URL for the job's output sandbox as a tar. Use as an href. */
  outputUrl: (jobId: string) => `${BASE}/jobs/${encodeURIComponent(jobId)}/output`,

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
} as const;

/**
 * A label for a job's state, in words the user can act on.
 *
 * Status 1 with no start time usually means the input upload has not
 * finished, which users read as "stuck" unless told otherwise. Being
 * specific here costs one line and saves a support email.
 */
export function jobStatusLabel(job: Job): string {
  switch (job.JobStatus) {
    case JobStatus.Idle:
      return job.QDate && Date.now() / 1000 - job.QDate < 30 ? 'Starting' : 'Waiting for a slot';
    case JobStatus.Running:
      return 'Running';
    case JobStatus.Removed:
      return 'Cancelled';
    case JobStatus.Completed:
      return job.ExitCode === 0 ? 'Finished' : `Failed (exit ${job.ExitCode})`;
    case JobStatus.Held:
      return job.HoldReason ? `Stopped: ${job.HoldReason}` : 'Stopped';
    case JobStatus.Transferring:
      return 'Copying results back';
    default:
      return 'Unknown';
  }
}
