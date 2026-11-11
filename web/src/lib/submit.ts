// Building the submit file.
//
// This is the part that is genuinely about your science, and the part
// you are meant to replace. It is a plain string builder on purpose:
// a submit file is text, the format is documented, and a template
// engine between you and it would only hide the thing you need to read
// when a job does not run.
//
// What NOT to put here:
//   - A log location, an accounting group, or anything else the access
//     point requires. The server applies site policy to every job.
//   - Anything derived from user input without escaping. See below.

/** Knobs this example exposes. Replace with your own. */
export interface RunOptions {
  pipeline: string;
  inputNames: string[];
  cpus: number;
  memoryMB: number;
}

/**
 * Quote a value for a submit-file command.
 *
 * Two separate hazards, both easy to miss:
 *
 *   `$(...)` and `$$(...)` are macro substitutions evaluated by the
 *   submit processor, and `$ENV(HOME)` reads the environment of the
 *   process doing the submitting -- which is the SERVER, not the user.
 *   A file name a user typed must not be able to reach either. `$` is
 *   escaped as `$(DOLLAR)`, which is the documented literal.
 *
 *   Newlines end a command. One in a value turns the rest of the line
 *   into a new submit command of the user's choosing.
 */
export function quote(value: string): string {
  return value.replace(/\$/g, '$(DOLLAR)').replace(/[\r\n]+/g, ' ').trim();
}

/** Reject a file name that cannot safely be a transfer entry. */
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    !/[\r\n,"]/.test(name)
  );
}

export function buildSubmitFile(opts: RunOptions): string {
  const inputs = opts.inputNames.filter(isSafeFileName).map(quote);

  return [
    `executable = /usr/bin/env`,
    `transfer_executable = false`,
    `arguments = "bash -c 'echo running ${quote(opts.pipeline)} on ${inputs.length} file(s); ls -l'"`,
    ``,
    `request_cpus = ${Math.max(1, Math.floor(opts.cpus))}`,
    `request_memory = ${Math.max(128, Math.floor(opts.memoryMB))}`,
    `request_disk = 1024`,
    ``,
    `should_transfer_files = YES`,
    `when_to_transfer_output = ON_EXIT`,
    inputs.length ? `transfer_input_files = ${inputs.join(',')}` : ``,
    ``,
    `output = stdout.txt`,
    `error = stderr.txt`,
    ``,
    // A batch name is how the app finds its own jobs later without
    // keeping a database: the queue is the record.
    `JobBatchName = ${quote(opts.pipeline)}`,
    ``,
    `queue 1`,
    ``,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
