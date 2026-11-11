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
 * The attributes this app reads off a job.
 *
 * This list is the contract with the server: anything not named here
 * comes back undefined, whatever the job actually holds. Keep it in
 * step with what the components read -- a field added to the UI but
 * not to this list fails quietly and looks like a backend bug.
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
  'HoldReason',
  // Needed to tell 'spooling your input' (16) apart from a real
  // problem. Without it every just-submitted job reads as failed.
  'HoldReasonCode',
  // Set by this app with `+FitsTitle` in the submit file. The queue is
  // the only record this app keeps, so the name the user gave a file
  // has to live on the job or the list cannot say which image is which
  // after a reload.
  'FitsTitle',
  'FitsPreview',
] as const satisfies readonly string[];

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
  HoldReasonCode?: number;
  ExitCode?: number;
  FitsTitle?: string;
  FitsPreview?: string;
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
   * Submit first, upload second. The server submits with input
   * spooling on, so the job is HELD -- HoldReasonCode 16,
   * SpoolingInput -- from the moment it is created until this upload
   * lands. That is normal and is not a failure; see jobStatusLabel,
   * which must say so in words or the user reads their brand-new job
   * as broken.
   *
   * There is no `hold` option on submit. JobSubmitRequest has exactly
   * one field, `submit_file`. (An earlier version of this comment
   * described a `hold = true` parameter that does not exist -- the
   * precise mistake AGENTS.md warns about, shipped in the client it
   * tells you to extend.)
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
   */
  hold: (jobId: string, reason = 'Stopped from the web interface') =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/hold`, {
      // The reason comes back as HoldReason, so the interface can tell
      // a job the user stopped apart from one the pool held. Without
      // it both read the same, and "say what happened" becomes
      // impossible for the one case you caused yourself.
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Release a held job so it can run again. */
  release: (jobId: string) =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/release`, { method: 'POST' }),

  /** URL for the job's output sandbox as a tar. Use as an href. */
  outputUrl: (jobId: string) => `${BASE}/jobs/${encodeURIComponent(jobId)}/output`,

  /**
   * URL for ONE named file out of a finished job's sandbox.
   *
   * This is how a result that is a PICTURE gets to the page, and the
   * mechanism is worth being explicit about, because the obvious
   * alternative does not work here:
   *
   *   fetch() the bytes, URL.createObjectURL(blob), point an <img> at
   *   the blob: URL -- which the access point's
   *   `Content-Security-Policy: default-src 'self'` blocks, because
   *   blob: is not 'self'. The image silently does not appear.
   *
   * Used directly as an <img src>, this URL is same-origin, so the CSP
   * allows it and the browser attaches the session cookie exactly as
   * it does for an API call. No fetch, no blob, no base64 in the page,
   * and the browser's own cache does the right thing when the list
   * re-renders.
   *
   * The server sets Content-Type from the file's own bytes
   * (http.DetectContentType), so a real PNG arrives as image/png
   * without the app having to say so.
   */
  fileUrl: (jobId: string, name: string) =>
    `${BASE}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`,

  /**
   * One named file out of a job's sandbox, as text.
   *
   * `request` assumes JSON and this endpoint does not promise it: the
   * Content-Type is sniffed from the bytes, and the bytes of an empty
   * pre-created results.json are not JSON. Read text, parse upstairs,
   * and let parseResults turn "empty" into a sentence.
   *
   * A 404 here is routine, not an error worth shouting about: the
   * sandbox is not there until the job's output has been transferred
   * back.
   */
  jobFileText: async (jobId: string, name: string): Promise<string> => {
    const res = await fetch(
      `${BASE}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`,
      { credentials: 'include' },
    );
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Session expired');
    }
    if (!res.ok) {
      throw new ApiError(res.status, `${name} is not among this job's results yet`);
    }
    return res.text();
  },

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

/**
 * The hold codes worth telling apart.
 *
 * SpoolingInput is not a failure: the server submits with spooling
 * on, so every job is held under this code between submit and the
 * input upload. UploadFileError is what you get when a declared
 * output file was missing at the end -- see AGENTS.md.
 */
export const HoldReasonCode = {
  DownloadFileError: 12,
  UploadFileError: 13,
  SpoolingInput: 16,
} as const;

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
      return 'Processing';
    case JobStatus.Removed:
      return 'Cancelled';
    case JobStatus.Completed:
      // Not "exit 65". The job always writes a message into
      // results.json saying what went wrong in words; the list says
      // only that something did, and the results panel says what.
      return job.ExitCode === 0 ? 'Finished' : 'Finished with a problem';
    case JobStatus.Held:
      return heldLabel(job);
    case JobStatus.Transferring:
      return 'Copying results back';
    default:
      return 'Unknown';
  }
}

function heldLabel(job: Job): string {
  switch (job.HoldReasonCode) {
    case HoldReasonCode.SpoolingInput:
      // NOT an error. Every job passes through this between POST /jobs
      // and the input upload, and for this app -- where the input is a
      // few hundred megabytes of FITS -- it is where the job spends
      // most of its life. Calling it "Stopped" would tell the user
      // their submission failed, every single time, for minutes.
      return 'Receiving your image';
    case HoldReasonCode.DownloadFileError:
      return 'The image could not be copied to the compute node';
    case HoldReasonCode.UploadFileError:
      return 'The results could not be copied back';
    default:
      return job.HoldReason ? `Stopped: ${job.HoldReason}` : 'Stopped';
  }
}

/**
 * True while a job is still waiting for the files the app is uploading.
 *
 * Keeps the Stop control away from a job that is mid-upload: holding an
 * already-held job does nothing visible, and the state is not a problem
 * to be fixed.
 */
export function isReceivingFiles(job: Job): boolean {
  return job.JobStatus === JobStatus.Held && job.HoldReasonCode === HoldReasonCode.SpoolingInput;
}

/** True once the job has stopped and its sandbox can be read. */
export function isFinished(job: Job): boolean {
  return job.JobStatus === JobStatus.Completed;
}
