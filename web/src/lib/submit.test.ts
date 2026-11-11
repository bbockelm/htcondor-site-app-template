import { describe, it, expect } from 'vitest';
import { buildSubmitFile, quote, isSafeFileName, OUTPUT_FILES } from './submit';

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
