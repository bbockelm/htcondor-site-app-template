import { describe, it, expect } from 'vitest';
import {
  BATCH_PREFIX,
  MAX_JOBS,
  OUTPUT_FILES,
  RUNNER_FILE,
  UPLOAD_BUDGET_BYTES,
  batchNameFor,
  buildRunnerScript,
  buildSubmitFile,
  chunk,
  databaseFileName,
  databaseKind,
  displayText,
  isSafeFileName,
  planSubmission,
  quote,
  requestMemoryMB,
  shQuote,
  type JobSpec,
} from './submit';

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

// commandNames returns the submit commands present, in order.
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

const base: JobSpec = {
  program: 'blastn',
  evalue: '1e-5',
  maxHits: 25,
  databaseLabel: 'reference.fasta',
  databaseKind: 'fasta',
  databaseFile: 'database.fasta',
  queryNames: ['a.fasta', 'b.fasta'],
  batchName: 'blast-blastn-20260101000000',
  databaseBytes: 50 * 1024 * 1024,
  queryBytes: 4096,
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

describe('isSafeFileName', () => {
  it('rejects paths and traversal', () => {
    for (const bad of ['../etc/passwd', 'a/b', '..', '.', '', 'a\nb', 'a,b']) {
      expect(isSafeFileName(bad)).toBe(false);
    }
  });

  it('accepts ordinary names', () => {
    for (const ok of ['sample.fastq.gz', 'run-01.cfg', 'IMG_0001.tif']) {
      expect(isSafeFileName(ok)).toBe(true);
    }
  });

  it('rejects the names that survive a transfer list but break a shell', () => {
    // These reach a comma-separated submit command, a multipart
    // Content-Disposition header AND a bash array. Asking the user to
    // rename is cheaper than being right about all three.
    for (const bad of ['a b.fa', "it's.fa", '$(x).fa', '-rf.fa', 'a"b.fa', 'a;b.fa', 'a\u0000b']) {
      expect(isSafeFileName(bad), bad).toBe(false);
    }
  });
});

describe('shQuote', () => {
  it('survives a single quote', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('displayText', () => {
  it('strips what awk -v would re-read as an escape', () => {
    // awk -v expands \t in the VALUE, so a tab or a backslash in a
    // database name lands in results.json as a control character and
    // JSON.parse throws on a job that ran perfectly.
    expect(displayText('my\tdb\\name.fa')).toBe('my db name.fa');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\\]/.test(displayText('a\u0001b\\c'))).toBe(false);
  });

  it('never returns an empty label', () => {
    expect(displayText('   ')).toBe('database');
  });
});

describe('databaseKind', () => {
  it('tells an archive from a FASTA from a compressed FASTA', () => {
    expect(databaseKind('refdb.tar.gz')).toBe('blastdb-archive');
    expect(databaseKind('refdb.TGZ')).toBe('blastdb-archive');
    expect(databaseKind('ref.fasta.gz')).toBe('fasta-gz');
    expect(databaseKind('ref.fna')).toBe('fasta');
  });

  it('renames the database to a sandbox name the user cannot influence', () => {
    // The user's own name still reaches results.json; it just never
    // reaches a submit command or a shell.
    expect(databaseFileName('my refs;rm -rf.tar.gz')).toBe('database.tar.gz');
    expect(databaseFileName('weird name.fa')).toBe('database.fasta');
    expect(isSafeFileName(databaseFileName('weird name.fa'))).toBe(true);
  });
});

describe('planSubmission', () => {
  // THE decision this app makes. The database is uploaded once per job
  // because the API has no shared stage, so the job count is bounded by
  // the upload budget and nothing else.
  it('spreads a small database over many jobs, up to the cap', () => {
    const p = planSubmission({ databaseBytes: 1e6, queryBytesTotal: 1e5, queryCount: 500 });
    expect(p.jobs).toBeLessThanOrEqual(MAX_JOBS);
    expect(p.jobs).toBeGreaterThan(MAX_JOBS / 2);
    expect(p.limit).toBe('job-cap');
  });

  it('refuses to turn a large database into many uploads', () => {
    const oneGiB = 1024 * 1024 * 1024;
    const p = planSubmission({ databaseBytes: oneGiB, queryBytesTotal: 0, queryCount: 500 });
    expect(p.jobs).toBe(UPLOAD_BUDGET_BYTES / oneGiB);
    expect(p.limit).toBe('database-size');
    expect(p.uploadBytes).toBeLessThanOrEqual(UPLOAD_BUDGET_BYTES);
  });

  it('never plans more jobs than there are query files', () => {
    const p = planSubmission({ databaseBytes: 1, queryBytesTotal: 10, queryCount: 3 });
    expect(p.jobs).toBe(3);
    expect(p.limit).toBe('queries');
  });

  it('never plans an empty job', () => {
    for (const queryCount of [1, 2, 7, 10, 41, 99, 1000]) {
      const p = planSubmission({ databaseBytes: 1e6, queryBytesTotal: 1, queryCount });
      expect(p.jobs * p.queriesPerJob).toBeGreaterThanOrEqual(queryCount);
      expect((p.jobs - 1) * p.queriesPerJob).toBeLessThan(queryCount);
    }
  });

  it('counts the real cost of the submission', () => {
    const p = planSubmission({ databaseBytes: 1000, queryBytesTotal: 55, queryCount: 4 });
    expect(p.uploadBytes).toBe(p.jobs * 1000 + 55);
  });

  it('plans nothing without queries', () => {
    expect(planSubmission({ databaseBytes: 10, queryBytesTotal: 0, queryCount: 0 }).jobs).toBe(0);
  });
});

describe('chunk', () => {
  it('keeps every item exactly once, in order', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunk(items, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunk(items, 3).flat()).toEqual(items);
  });
});

describe('buildSubmitFile', () => {
  it('asks for resources that scale with the database', () => {
    expect(commandValue(buildSubmitFile(base), 'request_cpus')).toBe('2');
    expect(requestMemoryMB(0)).toBe(2048);
    expect(requestMemoryMB(4 * 1024 * 1024 * 1024)).toBeGreaterThan(requestMemoryMB(0));
    expect(requestMemoryMB(1e15)).toBeLessThanOrEqual(16384);
  });

  it('transfers the runner, the database and this job\'s queries, and nothing else', () => {
    const value = commandValue(buildSubmitFile(base), 'transfer_input_files');
    expect(value).toBe(`${RUNNER_FILE},database.fasta,a.fasta,b.fasta`);
  });

  it('drops unsafe query names rather than emitting them', () => {
    const f = buildSubmitFile({ ...base, queryNames: ['ok.fasta', '../escape'] });
    expect(commandValue(f, 'transfer_input_files')).toBe(`${RUNNER_FILE},database.fasta,ok.fasta`);
  });

  it('does not let a batch name inject a command', () => {
    const f = buildSubmitFile({ ...base, batchName: 'x\nexecutable = /bin/evil' });
    expect(commandValue(f, 'executable')).toBe('/usr/bin/env');
  });

  it('groups a search under one batch name the app can find again', () => {
    expect(commandValue(buildSubmitFile(base), 'JobBatchName')).toBe(base.batchName);
    expect(batchNameFor('blastp')).toMatch(new RegExp(`^${BATCH_PREFIX}blastp-\\d{14}$`));
  });

  it('ends with a queue statement, one job per submission', () => {
    // One cluster per group of queries, NOT `queue N`: each job's
    // transfer_input_files names its own queries, and a single submit
    // file cannot name a different set per proc.
    expect(buildSubmitFile(base).trim().endsWith('queue 1')).toBe(true);
  });
});

describe('output files', () => {
  it('declares exactly the files it creates, and no others', () => {
    // toEqual, not toContain. commandValue returns the EFFECTIVE value
    // -- the last assignment before `queue` -- and a toContain on it
    // passes even when a stray later line has overridden a correct
    // earlier one.
    const declared = (commandValue(buildSubmitFile(base), 'transfer_output_files') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(declared).toEqual([...OUTPUT_FILES]);

    // And only one such command exists, so nothing can override it.
    const names = commandNames(buildSubmitFile(base));
    expect(names.filter((n) => n === 'transfer_output_files')).toHaveLength(1);
  });

  // HTCondor holds a job whose declared output file is missing at the
  // end. A job that writes results.json only on success is therefore
  // held on every failure, for "missing output" -- which says nothing
  // about what went wrong and leaves the user staring at a state
  // nobody can explain. Creating it first makes a failure report
  // itself.
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
      // ...and created BEFORE it is written, not after.
      const writtenAt = args.indexOf(`> ${out}`, createdAt + 1);
      if (writtenAt >= 0) expect(createdAt).toBeLessThan(writtenAt);
    }
  });

  it('pre-creates the outputs before the runner script is even read', () => {
    // The runner script is an uploaded file. If it is missing, or has a
    // syntax error, the job must still come back as a failure rather
    // than as a hold for a file-transfer error nobody can read.
    const args = commandValue(buildSubmitFile(base), 'arguments') ?? '';
    const runnerAt = args.indexOf(RUNNER_FILE);
    expect(runnerAt).toBeGreaterThan(0);
    for (const out of OUTPUT_FILES) {
      const createdAt = args.indexOf(`: > ${out}`);
      expect(createdAt, `${out} is not created in arguments at all`).toBeGreaterThanOrEqual(0);
      expect(createdAt).toBeLessThan(runnerAt);
    }
  });

  it('brings back a structured file for the page to render', () => {
    const declared = (commandValue(buildSubmitFile(base), 'transfer_output_files') ?? '').split(',');
    expect(declared.some((f) => f.trim().endsWith('.json'))).toBe(true);
  });
});

describe('buildRunnerScript', () => {
  it('runs the chosen program with the chosen thresholds', () => {
    const s = buildRunnerScript({ ...base, program: 'blastx', evalue: '1e-20', maxHits: 100 });
    expect(s).toContain("PROGRAM='blastx'");
    expect(s).toContain("EVALUE='1e-20'");
    expect(s).toContain('MAXHITS=100');
    // blastx searches a PROTEIN database, so makeblastdb must be told
    // prot even though the queries are DNA. Getting this backwards
    // produces a database that builds and never matches anything.
    expect(s).toContain("DBTYPE='prot'");
  });

  it('falls back rather than passing through a value it does not know', () => {
    const s = buildRunnerScript({ ...base, evalue: '1e-5; rm -rf /', maxHits: -1 });
    expect(s).toContain("EVALUE='1e-5'");
    expect(s).toContain('MAXHITS=25');
    expect(s).not.toContain('rm -rf');
  });

  it('single-quotes every query name', () => {
    const s = buildRunnerScript({ ...base, queryNames: ['a.fasta', 'b-2.fasta'] });
    expect(s).toContain("QUERIES=('a.fasta' 'b-2.fasta')");
  });

  it('writes results.json on the failure path too', () => {
    // Every exit goes through finish(), which is what stops a failed
    // job from coming back with nothing for the page to show.
    const s = buildRunnerScript(base);
    expect(s).toContain('> results.json');
    const calls = s.match(/^\s*finish /gm) ?? [];
    expect(calls.length).toBeGreaterThan(4);
    expect(s).toContain('finish ok "" 0');
  });

  it('says what to do when BLAST is not installed', () => {
    const s = buildRunnerScript(base);
    expect(s).toContain('does not have $1 installed');
    expect(s).toMatch(/need "\$PROGRAM"/);
  });
});
