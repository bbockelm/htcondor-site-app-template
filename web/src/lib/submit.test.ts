import { describe, it, expect } from 'vitest';
import { adString, batchNameFor, BATCH_PREFIX, buildSubmitFile, quote } from './submit';
import { OUTPUT_FILES, RUNNER_FILE } from './runner';
import { jobStatusLabel, JOB_ATTRS, HoldReasonCode, type Job } from './api';

// The effective value of a submit command is the LAST assignment before
// `queue`, which is what the submit processor evaluates. Asserting on
// that rather than on "the file contains the string" is the point: a
// substring check passes even when a later line overrides the value.
function commandValue(submitFile: string, command: string): string | undefined {
  let value: string | undefined;
  for (const raw of submitFile.split('\n')) {
    const line = raw.trim();
    if (/^queue\b/i.test(line)) break;
    const m = line.match(/^([A-Za-z_+][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1].toLowerCase() === command.toLowerCase()) value = m[2].trim();
  }
  return value;
}

function commandNames(submitFile: string): string[] {
  const names: string[] = [];
  for (const raw of submitFile.split('\n')) {
    const line = raw.trim();
    if (/^queue\b/i.test(line)) break;
    const m = line.match(/^([A-Za-z_+][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

const base = {
  inputNames: ['hst_f814w.fits'],
  inputBytes: 120 * 1024 * 1024,
  batchName: 'fitsprev-each-20260101000000',
  title: 'hst_f814w.fits',
};

describe('quote', () => {
  it('neutralizes macro substitution', () => {
    // $ENV(HOME) would otherwise read the SERVER's environment.
    expect(quote('$ENV(HOME)')).toBe('$(DOLLAR)ENV(HOME)');
    expect(quote('$(Cluster)')).toBe('$(DOLLAR)(Cluster)');
  });

  it('collapses newlines so a value cannot start a new command', () => {
    expect(quote('a\nexecutable = /bin/sh')).not.toContain('\n');
  });
});

describe('adString', () => {
  it('produces a ClassAd string literal, quotes included', () => {
    expect(adString('plain')).toBe('"plain"');
    expect(adString('say "hi"')).toBe('"say \\"hi\\""');
    expect(adString('back\\slash')).toBe('"back\\\\slash"');
  });

  // adString first (ClassAd grammar), quote second (macro expansion),
  // because macro expansion happens before the ClassAd is parsed.
  it('composes with quote so a title cannot reach either layer', () => {
    const value = quote(adString('$ENV(HOME)"; Requirements = false'));
    expect(value).not.toContain('$ENV');
    expect(value.startsWith('"') && value.endsWith('"')).toBe(true);
  });
});

describe('buildSubmitFile', () => {
  it('uses batch_name, not a JobBatchName macro', () => {
    // `JobBatchName = x` in a submit file defines a submit MACRO and
    // sets nothing on the job ad, so the queue constraint in app.tsx
    // would match nothing and the job list would stay empty with no
    // error anywhere. batch_name is the command that sets it.
    const f = buildSubmitFile(base);
    expect(commandValue(f, 'batch_name')).toBe(base.batchName);
    expect(commandNames(f)).not.toContain('jobbatchname');
  });

  it('transfers the runner and the images, runner first', () => {
    const f = buildSubmitFile({ ...base, inputNames: ['a.fits', 'b.fits'] });
    expect(commandValue(f, 'transfer_input_files')).toBe(`${RUNNER_FILE},a.fits,b.fits`);
  });

  it('drops unsafe names rather than emitting them', () => {
    const f = buildSubmitFile({ ...base, inputNames: ['ok.fits', '../escape', 'my frame.fits'] });
    expect(commandValue(f, 'transfer_input_files')).toBe(`${RUNNER_FILE},ok.fits`);
  });

  it('asks for resources that scale with the file', () => {
    const small = buildSubmitFile({ ...base, inputBytes: 1024 });
    const large = buildSubmitFile({ ...base, inputBytes: 800 * 1024 * 1024 });
    expect(Number(commandValue(small, 'request_memory'))).toBe(2048);
    expect(Number(commandValue(large, 'request_memory'))).toBeGreaterThan(2048);
    expect(Number(commandValue(large, 'request_disk'))).toBeGreaterThan(
      Number(commandValue(small, 'request_disk')),
    );
  });

  it('does not let a title inject a submit command', () => {
    const f = buildSubmitFile({ ...base, title: 'x\nexecutable = /bin/evil' });
    expect(commandValue(f, 'executable')).toBe('/usr/bin/env');
  });

  it('leaves site policy to the access point', () => {
    const names = commandNames(buildSubmitFile(base));
    for (const forbidden of ['log', 'accounting_group', 'accounting_group_user', 'universe']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('ends with a queue statement', () => {
    expect(buildSubmitFile(base).trim().endsWith('queue 1')).toBe(true);
  });
});

describe('output files', () => {
  it('declares exactly the files it creates, and no others', () => {
    const declared = (commandValue(buildSubmitFile(base), 'transfer_output_files') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(declared).toEqual([...OUTPUT_FILES]);

    const names = commandNames(buildSubmitFile(base));
    expect(names.filter((n) => n === 'transfer_output_files')).toHaveLength(1);
  });

  // HTCondor holds a job whose declared output file is missing at the
  // end, and the hold reads as a file-transfer error, which says
  // nothing about what actually went wrong.
  it('creates every declared output file before any work can fail', () => {
    const f = buildSubmitFile(base);
    const declared = (commandValue(f, 'transfer_output_files') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);
    const args = commandValue(f, 'arguments') ?? '';
    for (const out of declared) {
      const createdAt = args.indexOf(`: > ${out}`);
      expect(createdAt, `${out} is declared but never created up front`).toBeGreaterThanOrEqual(0);
      // ... and before the runner is even read, so that a runner which
      // cannot be parsed still fails as itself.
      expect(createdAt).toBeLessThan(args.indexOf(RUNNER_FILE));
    }
  });

  it('brings back a structured file for the page to render', () => {
    const declared = (commandValue(buildSubmitFile(base), 'transfer_output_files') ?? '').split(
      ',',
    );
    expect(declared.some((f) => f.trim().endsWith('.json'))).toBe(true);
  });
});

describe('batchNameFor', () => {
  it('is safe by construction and carries the prefix the list filters on', () => {
    const name = batchNameFor('composite', new Date('2026-03-04T05:06:07Z'));
    expect(name.startsWith(BATCH_PREFIX)).toBe(true);
    expect(name).toMatch(/^[A-Za-z0-9-]+$/);
    expect(quote(name)).toBe(name);
  });
});

describe('job status labels', () => {
  const held = { ClusterId: 1, ProcId: 0, JobStatus: 5 } as Job;

  // The state EVERY job is in between submit and the input upload --
  // and for this app, where the input is hundreds of megabytes of
  // FITS, the state it spends most of its life in.
  it('does not call a job that is spooling its input "stopped"', () => {
    const label = jobStatusLabel({
      ...held,
      HoldReasonCode: HoldReasonCode.SpoolingInput,
      HoldReason: 'Spooling input data files',
    });
    expect(label.toLowerCase()).not.toContain('stop');
    expect(label.toLowerCase()).not.toContain('fail');
    expect(label).toMatch(/receiv/i);
  });

  it('explains a transfer hold instead of quoting its code', () => {
    const label = jobStatusLabel({ ...held, HoldReasonCode: HoldReasonCode.UploadFileError });
    expect(label).not.toMatch(/\b13\b/);
    expect(label).toMatch(/copied back/i);
  });

  it('never shows a bare exit status', () => {
    const label = jobStatusLabel({ ClusterId: 1, ProcId: 0, JobStatus: 4, ExitCode: 65 } as Job);
    expect(label).not.toContain('65');
  });

  // The labels can only tell these apart if the attributes are asked
  // for; none of them is in the server's default projection.
  it('asks for every attribute the interface reads', () => {
    for (const attr of [
      'JobStatus',
      'ExitCode',
      'HoldReason',
      'HoldReasonCode',
      'QDate',
      'JobBatchName',
      'FitsTitle',
    ]) {
      expect(JOB_ATTRS as readonly string[]).toContain(attr);
    }
  });
});
