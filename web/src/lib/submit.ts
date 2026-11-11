// Building the submit file.
//
// One job counts the words in one file.
//
// The user's TEXT never reaches this file. It is uploaded under a fixed
// name (INPUT_NAME) after the job is created, so `transfer_input_files`
// and `arguments` are constants, and the counting options live inside
// the awk program rather than in a submit command.
//
// The file NAME does reach it, once, as +WordFreqFile -- because the
// job list has to be able to say "moby-dick.txt finished" after the
// user reloads the page, and the queue is the only record there is. It
// goes through two escapes in the right order, which is the part worth
// being careful about:
//
//   1. adString() makes it a valid ClassAd string literal (backslash
//      and double quote escaped, newlines removed);
//   2. quote() then neutralises `$`, because macro expansion happens
//      BEFORE the ClassAd is parsed -- `$ENV(HOME)` in a value reads
//      the environment of the process doing the submitting, which is
//      the SERVER, and `$(Cluster)` would be substituted.
//
// Doing those two in the other order would let step 1's backslashes be
// reinterpreted, so the order is not a style preference.
//
// What NOT to put here: a log location, an accounting group, a
// concurrency limit, or anything else this access point requires. The
// server applies site policy to every job it accepts.
//
// TWO THINGS ABOUT OUTPUT, both from the template and both load-bearing
// here:
//
//  1. The job writes a STRUCTURED result -- results.json -- alongside
//     the text summary it prints for a human. The page draws a sortable
//     table from the JSON; the text is kept because it is what a user
//     pastes into a message to a colleague. Only the job knows the
//     shape of its own output, so it emits both rather than making the
//     page parse prose.
//
//  2. HTCondor HOLDS a job whose declared output file does not exist
//     when it finishes. Every file named in transfer_output_files is
//     therefore created, empty, as the first thing the job does -- see
//     OUTPUT_FILES and the `: >` prefix in `arguments`. Without that, a
//     file the user dropped that turns out not to be text would be held
//     for "missing output" instead of reporting what was actually
//     wrong, and a hold is the one state this interface cannot explain.

import { INPUT_NAME, OUTPUT_FILES, PROGRAM_NAME } from './wordfreq';

/**
 * The batch name every job from this app carries.
 *
 * It is how the app finds its own jobs again without keeping a
 * database: the queue is the record. Change it and running jobs from
 * the previous version disappear from the list.
 */
export const BATCH_NAME = 'wordfreq';

// Counting words in a text file needs neither of these to be a knob:
// awk is single-threaded, and its memory is the distinct vocabulary,
// which does not grow with the file the way the file does.
const REQUEST_CPUS = 1;
const REQUEST_MEMORY_MB = 1024;

/**
 * Disk for the input, the CSV of every distinct word, and room to
 * spare. request_disk is in KiB.
 */
export function requestDiskKB(inputBytes: number): number {
  const kb = Math.ceil(Math.max(0, inputBytes) / 1024);
  return Math.max(512 * 1024, kb * 3);
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

/**
 * Quote a value as a ClassAd string literal, braces and all.
 *
 * Separate from `quote` and applied first: this is about the ClassAd
 * grammar, that one is about macro expansion, and they escape
 * different characters.
 */
export function adString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
  return `"${escaped}"`;
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

/**
 * What the job runs.
 *
 * Every file in OUTPUT_FILES is created empty FIRST, before awk can
 * fail. HTCondor holds a job whose declared output file is missing at
 * the end, and a hold for "missing output" tells the user nothing
 * about the file they dropped. An empty-but-present file lets the real
 * failure -- a non-zero exit, a message on stderr -- be the thing they
 * see.
 *
 * It is one `bash -c` string because `: >` is shell, not awk. Nothing
 * in it is derived from user input: the names are module constants.
 */
export function jobScript(): string {
  return [...OUTPUT_FILES.map((f) => `: > ${f}`), `awk -f ${PROGRAM_NAME} ${INPUT_NAME}`].join(
    '; ',
  );
}

/**
 * The submit file for one word-frequency job.
 *
 * `/usr/bin/env` with `transfer_executable = false` is the executable
 * because the thing we actually run, the awk program, arrives as an
 * input file. Naming it as the executable instead would mean the
 * submit had to succeed against a file that does not exist yet --
 * inputs are uploaded AFTER the job is created.
 *
 * `displayName` is what the user called the file -- it is recorded on
 * the job so the list can name it later -- and `inputBytes` its size.
 * Nothing else about this file varies between jobs, by design.
 */
export function buildSubmitFile(displayName: string, inputBytes: number): string {
  const label = quote(adString(displayName));

  return [
    `# Word frequency count. Generated by the Word Frequency site app;`,
    `# site policy (log location, accounting group) is applied by the`,
    `# access point and deliberately absent here.`,
    ``,
    `executable = /usr/bin/env`,
    `transfer_executable = false`,
    `arguments = "bash -c '${jobScript()}'"`,
    ``,
    `request_cpus = ${REQUEST_CPUS}`,
    `request_memory = ${REQUEST_MEMORY_MB}`,
    `request_disk = ${requestDiskKB(inputBytes)}`,
    ``,
    `should_transfer_files = YES`,
    `when_to_transfer_output = ON_EXIT`,
    `transfer_input_files = ${PROGRAM_NAME},${INPUT_NAME}`,
    // Declared, so they come back by name whatever else the job left
    // lying around -- and created at the start of the job, so
    // declaring them cannot turn a failure into a hold.
    `transfer_output_files = ${OUTPUT_FILES.join(',')}`,
    ``,
    `output = stdout.txt`,
    `error = stderr.txt`,
    ``,
    // batch_name, not `JobBatchName = ...`. A submit file is not a
    // ClassAd: an assignment to a name that is not a submit command
    // defines a submit MACRO, and the job ad attribute is set by the
    // `batch_name` command (or by `+Name` / `MY.Name` for a custom
    // attribute). The constraint in api.ts matches on JobBatchName, so
    // this line is what makes the job list work at all.
    `batch_name = ${quote(BATCH_NAME)}`,
    // A custom job attribute, which is what `+Name` means in a submit
    // file. The job list reads it back through the projection in
    // api.ts; if an access point were to strip it, the list falls back
    // to the job id rather than breaking.
    `+WordFreqFile = ${label}`,
    ``,
    `queue 1`,
    ``,
  ].join('\n');
}
