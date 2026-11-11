import { describe, it, expect } from 'vitest';
import { buildSubmitFile, quote, isSafeFileName, OUTPUT_FILES, jsonString } from './submit';
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

  // These all passed the older "no slashes, no newlines" rule, and
  // every one is a problem in transfer_input_files, in a multipart
  // filename, or on a shell command line.
  it('rejects names that are trouble further down the path', () => {
    for (const bad of ['my file.fa', "it's.fa", '$(x).fa', '-rf.fa', 'a"b.fa', '`id`.fa', 'a;b.fa']) {
      expect(isSafeFileName(bad), bad).toBe(false);
    }
  });

  it('accepts ordinary names', () => {
    for (const ok of ['sample.fastq.gz', 'run-01.cfg', 'IMG_0001.tif']) {
      expect(isSafeFileName(ok)).toBe(true);
    }
  });
});

describe('buildSubmitFile', () => {
  const base = { pipeline: 'align', inputNames: ['a.txt', 'b.txt'], cpus: 2, memoryMB: 2048 };

  it('sets the requested resources', () => {
    const f = buildSubmitFile(base);
    expect(commandValue(f, 'request_cpus')).toBe('2');
    expect(commandValue(f, 'request_memory')).toBe('2048');
  });

  it('floors resources that would be rejected or nonsensical', () => {
    const f = buildSubmitFile({ ...base, cpus: 0, memoryMB: 1 });
    expect(commandValue(f, 'request_cpus')).toBe('1');
    expect(commandValue(f, 'request_memory')).toBe('128');
  });

  it('lists the input files', () => {
    expect(commandValue(buildSubmitFile(base), 'transfer_input_files')).toBe('a.txt,b.txt');
  });

  it('omits transfer_input_files entirely when there are none', () => {
    // An empty value is not the same as absence: `transfer_input_files = `
    // is a command with an empty value, and the submit processor treats
    // that differently from the command never appearing.
    expect(commandValue(buildSubmitFile({ ...base, inputNames: [] }), 'transfer_input_files')).toBeUndefined();
  });

  it('drops unsafe file names rather than emitting them', () => {
    const f = buildSubmitFile({ ...base, inputNames: ['ok.txt', '../escape'] });
    expect(commandValue(f, 'transfer_input_files')).toBe('ok.txt');
  });

  it('does not let a pipeline name inject a command', () => {
    const f = buildSubmitFile({ ...base, pipeline: 'x\nexecutable = /bin/evil' });
    expect(commandValue(f, 'executable')).toBe('/usr/bin/env');
  });

  it('ends with a queue statement', () => {
    expect(buildSubmitFile(base).trim().endsWith('queue 1')).toBe(true);
  });
});

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

describe('output files', () => {
  const base = { pipeline: 'align', inputNames: ['a.txt'], cpus: 1, memoryMB: 512 };

  it('declares exactly the files it creates, and no others', () => {
    // toEqual, not toContain. commandValue returns the EFFECTIVE value
    // -- the last assignment before `queue` -- and a toContain on it
    // passes even when a stray later line has overridden a correct
    // earlier one. That is the trap commandValue exists to expose, and
    // this assertion used to fall straight into it: a merge once left
    // two transfer_output_files lines and the weaker check stayed
    // green while one file silently stopped coming back.
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
    // Asserts the PROPERTY, not the mechanism. An earlier version
    // required the literal `: > results.json` inside `arguments`,
    // which an app using `executable = my_script.sh` -- the shape the
    // API's own examples recommend -- cannot satisfy, so it failed
    // correct implementations. Here we only require that each
    // declared output is created somewhere the job reaches before it
    // can fail, and that creation comes before any write.
    const f = buildSubmitFile(base);
    const declared = (commandValue(f, 'transfer_output_files') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);

    // Look through the whole submit file, not one command: the job's
    // preamble may live in `arguments`, in an uploaded script, or in
    // a here-doc. If yours lives somewhere this cannot see, assert it
    // where it does live -- do not delete the test.
    for (const out of declared) {
      const createdAt = f.indexOf(`: > ${out}`);
      expect(createdAt, `${out} is declared but never created up front`).toBeGreaterThanOrEqual(0);
      const writtenAt = f.indexOf(`> ${out}`, createdAt + `: > ${out}`.length);
      if (writtenAt >= 0) expect(createdAt).toBeLessThan(writtenAt);
    }
  });

  it('brings back a structured file for the page to render', () => {
    // Asserts the OUTCOME -- a .json among the declared outputs --
    // not the mechanism that produces it. An earlier version of this
    // test required the word "printf" in `arguments`, which is true
    // of this example and false of any app whose job runs a real
    // program. A template test that fails when you do the right thing
    // a different way teaches people to delete tests.
    const declared = (commandValue(buildSubmitFile(base), 'transfer_output_files') ?? '').split(',');
    expect(declared.some((f) => f.trim().endsWith('.json'))).toBe(true);
  });
});

describe('job status labels', () => {
  const base = { ClusterId: 1, ProcId: 0, JobStatus: 5 } as Job;

  // The state every job is in between submit and the input upload.
  // Rendering it as "Stopped" tells the user their brand-new job
  // failed -- on every submission, which is the first thing they see.
  it('does not call a job that is spooling its input "stopped"', () => {
    const label = jobStatusLabel({
      ...base,
      HoldReasonCode: HoldReasonCode.SpoolingInput,
      HoldReason: 'Spooling input data files',
    });
    expect(label.toLowerCase()).not.toContain('stop');
    expect(label.toLowerCase()).not.toContain('fail');
    expect(label).toMatch(/upload/i);
  });

  it('still reports a real hold with its reason', () => {
    const label = jobStatusLabel({
      ...base,
      HoldReasonCode: HoldReasonCode.UploadFileError,
      HoldReason: 'error reading from results.json',
    });
    expect(label).toContain('results.json');
  });

  // The label can only tell those two apart if the attribute is
  // requested. It is not in the server's default projection.
  it('asks for every attribute the labels read', () => {
    for (const attr of ['JobStatus', 'ExitCode', 'HoldReason', 'HoldReasonCode', 'QDate']) {
      expect(JOB_ATTRS as readonly string[]).toContain(attr);
    }
  });
});

describe('structured output is valid JSON whatever the user typed', () => {
  // A job that ran perfectly must not produce results.json the page
  // cannot parse. The failure would surface in the browser, nowhere
  // near its cause.
  it('survives a quote, a backslash and a newline in a user value', () => {
    for (const nasty of ['a"b', 'a\\\\b', 'a\nb', '"; rm -rf /', 'tab\there']) {
      const encoded = jsonString(nasty);
      expect(JSON.parse(encoded)).toBe(nasty);
      // and it brings its own quotes, so callers must not add more
      expect(encoded.startsWith('"') && encoded.endsWith('"')).toBe(true);
    }
  });

  it('the example submit file embeds the pipeline name JSON-encoded', () => {
    const f = buildSubmitFile({ pipeline: 'a"b', inputNames: [], cpus: 1, memoryMB: 512 });
    // The raw quote must not appear unescaped inside the printf format.
    expect(f).not.toContain('"pipeline":"a"b"');
  });
});
