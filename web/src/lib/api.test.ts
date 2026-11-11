import { describe, it, expect } from 'vitest';
import {
  HoldReasonCode,
  JOB_ATTRS,
  JobStatus,
  isFinished,
  isReceivingFiles,
  jobStatusLabel,
  type Job,
} from './api';

function job(j: Partial<Job>): Job {
  return { ClusterId: 1, ProcId: 0, JobStatus: JobStatus.Idle, ...j };
}

describe('JOB_ATTRS', () => {
  // GET /jobs returns ONLY the projection it is given. An attribute the
  // UI reads but this list does not name arrives undefined and renders
  // as a confident falsehood rather than failing.
  it('names every attribute the labels depend on', () => {
    for (const attr of ['JobStatus', 'ExitCode', 'HoldReason', 'HoldReasonCode', 'QDate']) {
      expect(JOB_ATTRS as readonly string[]).toContain(attr);
    }
  });
});

describe('jobStatusLabel', () => {
  // The state EVERY job of this app passes through. POST /jobs spools,
  // so the job is HELD until the input upload finishes -- and this app
  // uploads a whole BLAST database, so that is the longest part of a
  // submission. Calling it "Stopped" would make every single search
  // look broken at the moment it starts.
  it('does not call a job waiting for its files stopped', () => {
    const j = job({
      JobStatus: JobStatus.Held,
      HoldReasonCode: HoldReasonCode.SpoolingInput,
      HoldReason: 'Spooling input data files',
    });
    expect(jobStatusLabel(j)).toBe('Receiving its files');
    expect(jobStatusLabel(j)).not.toMatch(/stop/i);
    expect(isReceivingFiles(j)).toBe(true);
  });

  it('translates a transfer hold into what actually failed', () => {
    // HoldReasonCode 13 names a file-transfer problem and says nothing
    // about the science. Neither the code nor the raw reason text means
    // anything to a biologist.
    for (const [code, text] of [
      [HoldReasonCode.UploadFileError, /copied back/],
      [HoldReasonCode.DownloadFileError, /compute node/],
    ] as const) {
      const label = jobStatusLabel(job({ JobStatus: JobStatus.Held, HoldReasonCode: code }));
      expect(label).toMatch(text);
      expect(label).not.toMatch(/\b1[23]\b/);
    }
  });

  it('still surfaces a hold it does not recognise, rather than hiding it', () => {
    expect(
      jobStatusLabel(job({ JobStatus: JobStatus.Held, HoldReasonCode: 3, HoldReason: 'policy' })),
    ).toBe('Stopped: policy');
  });

  it('never shows a bare exit status', () => {
    const label = jobStatusLabel(job({ JobStatus: JobStatus.Completed, ExitCode: 70 }));
    expect(label).not.toMatch(/70|exit/i);
    expect(label).toBe('Finished with problems');
    expect(jobStatusLabel(job({ JobStatus: JobStatus.Completed, ExitCode: 0 }))).toBe('Finished');
  });

  it('distinguishes a job that has just arrived from one that is waiting', () => {
    const now = Date.now() / 1000;
    expect(jobStatusLabel(job({ JobStatus: JobStatus.Idle, QDate: now }))).toBe('Starting');
    expect(jobStatusLabel(job({ JobStatus: JobStatus.Idle, QDate: now - 600 }))).toBe(
      'Waiting for a slot',
    );
  });
});

describe('isFinished', () => {
  it('is true only when no more work will happen', () => {
    expect(isFinished(job({ JobStatus: JobStatus.Completed }))).toBe(true);
    expect(isFinished(job({ JobStatus: JobStatus.Removed }))).toBe(true);
    expect(isFinished(job({ JobStatus: JobStatus.Held }))).toBe(false);
    expect(isFinished(job({ JobStatus: JobStatus.Running }))).toBe(false);
  });
});
