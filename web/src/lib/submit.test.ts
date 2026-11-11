import { describe, it, expect } from 'vitest';
import { buildSubmitFile, quote, isSafeFileName } from './submit';

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
