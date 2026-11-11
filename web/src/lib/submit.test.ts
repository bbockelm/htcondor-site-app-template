import { describe, it, expect } from 'vitest';
import { BATCH_NAME, adString, buildSubmitFile, quote, isSafeFileName, requestDiskKB } from './submit';
import {
  CSV_NAME,
  DEFAULT_OPTIONS,
  INPUT_NAME,
  OUTPUT_FILES,
  PROGRAM_NAME,
  RESULTS_NAME,
  buildProgram,
} from './wordfreq';

// The effective value of a submit command is the LAST assignment before
// `queue`, which is what the submit processor evaluates. Asserting on
// that rather than on "the file contains the string" is the point: a
// substring check passes even when a later line overrides the value.
/** Every command name the submit processor would see, in order. */
function commandNames(submitFile: string): string[] {
  const names: string[] = [];
  for (const raw of submitFile.split('\n')) {
    const line = raw.trim();
    if (/^queue\b/i.test(line)) break;
    const m = line.match(/^(\+?[A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

function commandValue(submitFile: string, command: string): string | undefined {
  let value: string | undefined;
  for (const raw of submitFile.split('\n')) {
    const line = raw.trim();
    if (/^queue\b/i.test(line)) break;
    const m = line.match(/^(\+?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
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

describe('adString', () => {
  it('produces a quoted ClassAd literal', () => {
    expect(adString('notes.txt')).toBe('"notes.txt"');
  });

  it('escapes the characters that would end the literal', () => {
    expect(adString('a"b')).toBe('"a\\"b"');
    expect(adString('a\\b')).toBe('"a\\\\b"');
  });

  it('removes newlines, which no ClassAd string may contain', () => {
    expect(adString('a\nb')).toBe('"a b"');
  });
});

describe('isSafeFileName', () => {
  it('rejects paths and traversal', () => {
    for (const bad of ['../etc/passwd', 'a/b', '..', '.', '', 'a\nb', 'a,b']) {
      expect(isSafeFileName(bad)).toBe(false);
    }
  });

  it('accepts ordinary names', () => {
    for (const ok of ['moby-dick.txt', 'interview 3.txt', 'NOTES.TXT']) {
      expect(isSafeFileName(ok)).toBe(true);
    }
  });
});

describe('requestDiskKB', () => {
  it('never asks for less than half a gigabyte', () => {
    expect(requestDiskKB(0)).toBe(512 * 1024);
    expect(requestDiskKB(1024)).toBe(512 * 1024);
  });

  it('scales with the input once the input is the larger term', () => {
    expect(requestDiskKB(1024 * 1024 * 1024)).toBe(3 * 1024 * 1024);
  });
});

describe('buildSubmitFile', () => {
  const f = () => buildSubmitFile('moby-dick.txt', 4096);

  it('runs the generated counter against the uploaded text', () => {
    expect(commandValue(f(), 'executable')).toBe('/usr/bin/env');
    expect(commandValue(f(), 'transfer_executable')).toBe('false');
    // Every declared output is created first, then awk runs. See the
    // "output files" block below for why the order matters.
    expect(commandValue(f(), 'arguments')).toBe(
      `"bash -c ': > ${RESULTS_NAME}; : > ${CSV_NAME}; awk -f ${PROGRAM_NAME} ${INPUT_NAME}'"`,
    );
  });

  it('transfers the text and the program, under fixed names', () => {
    expect(commandValue(f(), 'transfer_input_files')).toBe(`${PROGRAM_NAME},${INPUT_NAME}`);
  });

  it('sets the batch name the job list queries on', () => {
    // Via `batch_name`, the submit COMMAND. A submit file is not a
    // ClassAd: `JobBatchName = wordfreq` would define a submit macro
    // and leave the job's attribute unset, and the queue query that
    // finds this app's jobs would match nothing.
    expect(commandValue(f(), 'batch_name')).toBe(BATCH_NAME);
    expect(commandValue(f(), 'JobBatchName')).toBeUndefined();
  });

  it('records the display name as a ClassAd string', () => {
    expect(commandValue(f(), '+WordFreqFile')).toBe('"moby-dick.txt"');
  });

  it('asks for resources that do not depend on user input', () => {
    expect(commandValue(f(), 'request_cpus')).toBe('1');
    expect(commandValue(f(), 'request_memory')).toBe('1024');
  });

  it('keeps the text itself out of the file entirely', () => {
    // Two submissions of different files with different options differ
    // only in the name and the disk request. Everything that varies
    // with what the user typed travels as an upload instead.
    const a = buildSubmitFile('x.txt', 4096).replace('"x.txt"', 'NAME');
    const b = buildSubmitFile('y.txt', 4096).replace('"y.txt"', 'NAME');
    expect(a).toBe(b);
  });

  describe('a hostile file name cannot change the job', () => {
    const attacks: [string, string][] = [
      ['newline', 'a\nexecutable = /bin/evil\n+X = "b'],
      ['macro', '$ENV(HOME)'],
      ['cluster macro', '$(Cluster)'],
      ['quote', 'a" \n executable = "/bin/evil'],
      ['backslash', 'a\\"'],
    ];

    for (const [label, name] of attacks) {
      it(`survives a ${label}`, () => {
        const file = buildSubmitFile(name, 4096);

        // The real question is not whether "/bin/evil" appears -- it
        // may legitimately appear INSIDE the quoted name -- but
        // whether the file gained a command. Comparing the whole list
        // of command names against a benign submission answers that
        // and keeps answering it when a command is added here later.
        expect(commandNames(file)).toEqual(commandNames(buildSubmitFile('safe.txt', 4096)));
        expect(commandValue(file, 'executable')).toBe('/usr/bin/env');
        expect(commandValue(file, 'batch_name')).toBe(BATCH_NAME);

        // $ never survives unescaped: it is the macro introducer.
        const value = commandValue(file, '+WordFreqFile') ?? '';
        expect(value.replace(/\$\(DOLLAR\)/g, '')).not.toContain('$');
      });
    }
  });

  it('ends with a queue statement', () => {
    expect(f().trim().endsWith('queue 1')).toBe(true);
  });
});

// Adapted from the template's own output-file tests. Two changes:
// buildSubmitFile here takes (displayName, inputBytes), and the JSON
// is written by the awk program rather than by a printf in
// `arguments` -- so the "emits JSON" test asserts against the program
// that actually writes it instead of against the shell string.

describe('output files', () => {
  const f = () => buildSubmitFile('moby-dick.txt', 4096);

  it('declares its structured output so it comes back', () => {
    expect(commandNames(f())).toContain('transfer_output_files');
    expect(commandValue(f(), 'transfer_output_files')).toContain(RESULTS_NAME);
  });

  it('declares exactly the files OUTPUT_FILES names', () => {
    const declared = (commandValue(f(), 'transfer_output_files') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    expect(declared).toEqual([...OUTPUT_FILES]);
  });

  // HTCondor holds a job whose declared output file is missing at the
  // end. A job that writes results.json only on success is therefore
  // held on every failure, for "missing output" -- which says nothing
  // about what went wrong and leaves the user staring at a state
  // nobody can explain. Creating it first makes a failure report
  // itself.
  it('creates every declared output file before any work can fail', () => {
    const file = f();
    const declared = (commandValue(file, 'transfer_output_files') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);

    const args = commandValue(file, 'arguments') ?? '';
    for (const out of declared) {
      const createdAt = args.indexOf(`: > ${out}`);
      expect(createdAt, `${out} is declared but never created up front`).toBeGreaterThanOrEqual(0);
      // ...and created BEFORE anything else runs, not after.
      const work = args.indexOf('awk ');
      expect(createdAt, `${out} is created after the work starts`).toBeLessThan(work);
    }
  });

  it('emits JSON the page can render, not only prose', () => {
    // The job writes results.json from inside the awk program, so that
    // is where the assertion belongs; asserting on a printf in
    // `arguments` would only describe the shell wrapper.
    const program = buildProgram('moby-dick.txt', DEFAULT_OPTIONS);
    expect(program).toContain(RESULTS_NAME);
    // The key as it appears in awk source, where the quotes are
    // escaped because they sit inside an awk string literal.
    expect(program).toContain('\\"words\\"');
  });
});
