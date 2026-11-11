// Building the BLAST search: the plan, the runner script, the submit file.
//
// THE CENTRAL DESIGN QUESTION: one database, many jobs.
//
// A BLAST search is one reference database searched by many query
// files. The database is shared by every job and is the big thing; the
// queries are small. So the only question that matters for cost is: how
// many times does the database cross the wire?
//
// What this access point actually offers, from openapi.json:
//
//   * POST /jobs            -- takes a submit file. Nothing else.
//   * POST /jobs/{jobId}/input/multipart
//                           -- uploads files into ONE job's sandbox.
//                              The path parameter is documented as
//                              "cluster.proc format (e.g. 23.4)".
//
// That is the whole file-staging surface. There is no endpoint that
// stores a file once and hands back something many jobs can reference:
// no user stash, no cluster-scoped sandbox, no signed URL. Every byte a
// job reads was uploaded into that job's own sandbox, by the browser,
// over the user's network.
//
// So the database is uploaded once PER JOB. There is no arrangement of
// these two endpoints that avoids it. Everything below is about
// bounding that cost rather than pretending it away.
//
// THE DECISION
//
//   Jobs are sized from the DATABASE, not from the queries.
//
//   jobs = min(number of query files, MAX_JOBS, UPLOAD_BUDGET / dbSize)
//
//   A 20 MB database with 200 query files runs as MAX_JOBS jobs and the
//   upload is trivial. A 1 GB database runs as 4 jobs, because 4 is
//   what fits in the upload budget, and those 4 jobs each chew through
//   50 query files in sequence. A database over MAX_DATABASE_BYTES is
//   refused outright with an explanation, because the alternative is a
//   browser upload that fails after an hour.
//
// WHAT IT COSTS, said plainly
//
//   * The user's uplink carries jobs x databaseSize. The app shows that
//     number before they press the button; it is the one number that
//     decides whether this submission is reasonable.
//   * Parallelism is capped by database size, not by the pool. A big
//     database means a long wall clock even on an empty pool. That is a
//     real loss and it is not recoverable here -- see below.
//   * The access point stores jobs x databaseSize in its spool for the
//     life of the search. A shared stage would store one copy.
//
// WHAT WOULD ACTUALLY FIX IT, and why it is not in this app
//
//   HTCondor can fetch an input from a URL
//   (transfer_input_files = https://.../db.tar.gz), which makes the
//   database travel once per EXECUTE NODE instead of once per job, and
//   lets a site cache dedupe it entirely. The submit file is passed
//   through verbatim, so the app could emit that today.
//
//   It is not here because nothing in this repository says whether this
//   pool's execute nodes have a working https transfer plugin, and
//   there is no API that reports it. Shipping it would mean handing a
//   biologist a control that either works or holds every job with a
//   file-transfer error, with no way for the app to tell which in
//   advance. The honest move is to leave it out and say so.
//
//   The real fix belongs in the API: one upload that many jobs can
//   name.
//
// TWO THINGS ABOUT OUTPUT, both inherited from the template and both
// still true here:
//
//  1. The job writes STRUCTURED results (results.json) as well as the
//     full table (hits.tsv). The page draws the first and offers the
//     second as a download.
//
//  2. HTCondor HOLDS a job whose declared output file is missing when
//     it finishes, and the hold says "file transfer error", which tells
//     the user nothing about what went wrong. So every declared output
//     is created empty before any work can fail -- and here that is
//     done in `arguments`, before the runner script is even read, so a
//     syntax error in the script still comes back as a real failure.

/**
 * Files the job brings back, declared and pre-created from one list.
 *
 * results.json is small and is what the page draws. hits.tsv is the
 * complete BLAST table and can be large; the page links to it rather
 * than parsing it.
 */
export const OUTPUT_FILES = ['results.json', 'hits.tsv'] as const;

/** The name the runner script has inside the job's sandbox. */
export const RUNNER_FILE = 'blast_run.sh';

/** Cores each job asks for, and the value passed to -num_threads. */
export const JOB_CPUS = 2;

/** Rows of hits.tsv copied into results.json for the page to draw. */
export const TOP_HITS = 100;

/**
 * Never upload more than this as a database. A browser upload of more
 * than a couple of gigabytes is an hour of waiting followed by a
 * failure, and a database that size belongs on the access point's own
 * storage, staged by a facilitator, not pushed through a web form.
 */
export const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Total bytes one submission may push to the access point. The
 * database is sent once per job, so this is what decides how many jobs
 * a search gets.
 */
export const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

/** Upper bound on jobs per search, so a folder of 5000 reads does not
 *  put 5000 clusters in the queue. */
export const MAX_JOBS = 40;

// ---------------------------------------------------------------- BLAST

export type ProgramId = 'blastn' | 'blastp' | 'blastx' | 'tblastn';

export interface Program {
  id: ProgramId;
  /** What the biologist is choosing, in their words. */
  label: string;
  /** What makeblastdb needs when the database arrives as FASTA. */
  dbType: 'nucl' | 'prot';
}

export const PROGRAMS: readonly Program[] = [
  { id: 'blastn', label: 'DNA sequences against a DNA database (blastn)', dbType: 'nucl' },
  { id: 'blastp', label: 'Protein sequences against a protein database (blastp)', dbType: 'prot' },
  { id: 'blastx', label: 'DNA sequences against a protein database (blastx)', dbType: 'prot' },
  { id: 'tblastn', label: 'Protein sequences against a DNA database (tblastn)', dbType: 'nucl' },
];

export function programById(id: string): Program {
  return PROGRAMS.find((p) => p.id === id) ?? PROGRAMS[0];
}

/**
 * E-value choices, loosest last. A free-text box here invites `1e-5 ;
 * rm -rf` and, far more often, a typo that silently returns nothing.
 */
export const EVALUES = [
  { value: '1e-50', label: 'Only near-identical matches (1e-50)' },
  { value: '1e-20', label: 'Strong matches (1e-20)' },
  { value: '1e-5', label: 'Good matches (1e-5) — usual choice' },
  { value: '0.01', label: 'Weak matches too (0.01)' },
  { value: '10', label: 'Everything, including noise (10)' },
] as const;

export const MAX_HITS = [5, 25, 100, 500] as const;

export function isValidEvalue(v: string): boolean {
  return EVALUES.some((e) => e.value === v);
}

export function isValidMaxHits(n: number): boolean {
  return (MAX_HITS as readonly number[]).includes(n);
}

/** How the database arrived, decided in the browser so the job does not
 *  have to sniff it. */
export type DatabaseKind = 'blastdb-archive' | 'fasta-gz' | 'fasta';

const ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz', '.tar'];

export function databaseKind(originalName: string): DatabaseKind {
  const n = originalName.toLowerCase();
  if (ARCHIVE_SUFFIXES.some((s) => n.endsWith(s))) return 'blastdb-archive';
  if (n.endsWith('.gz')) return 'fasta-gz';
  return 'fasta';
}

/**
 * The name the database has inside the sandbox.
 *
 * Deliberately NOT the name the user gave it. The sandbox name is
 * chosen here so it can never collide with a query file, never need
 * quoting, and never carry a surprise through the submit file. The
 * user's own name is still reported back in results.json.
 */
export function databaseFileName(originalName: string): string {
  switch (databaseKind(originalName)) {
    case 'blastdb-archive':
      return originalName.toLowerCase().endsWith('.tar') ? 'database.tar' : 'database.tar.gz';
    case 'fasta-gz':
      return 'database.fasta.gz';
    default:
      return 'database.fasta';
  }
}

// ------------------------------------------------------------- planning

export interface Plan {
  /** How many jobs this search becomes. */
  jobs: number;
  /** Query files in the largest job. */
  queriesPerJob: number;
  /** Bytes the browser will push: jobs x database, plus the queries. */
  uploadBytes: number;
  /** Why it is not more jobs than this. Drives the sentence shown. */
  limit: 'queries' | 'database-size' | 'job-cap' | 'none';
}

export interface PlanInput {
  databaseBytes: number;
  queryBytesTotal: number;
  queryCount: number;
}

/**
 * How many jobs, and what it costs to run them.
 *
 * The database is uploaded once per job -- see the header. So the job
 * count is a budget decision, not a parallelism decision, and the one
 * number worth showing the user is `uploadBytes`.
 */
export function planSubmission(input: PlanInput): Plan {
  const { databaseBytes, queryBytesTotal, queryCount } = input;
  if (queryCount <= 0) {
    return { jobs: 0, queriesPerJob: 0, uploadBytes: 0, limit: 'none' };
  }

  const byBudget =
    databaseBytes > 0 ? Math.max(1, Math.floor(UPLOAD_BUDGET_BYTES / databaseBytes)) : MAX_JOBS;

  let jobs = Math.min(queryCount, MAX_JOBS, byBudget);
  const queriesPerJob = Math.ceil(queryCount / jobs);
  // Re-derive so no job is left empty: 10 queries over 4 jobs is 3 per
  // job and therefore 4 jobs, but 10 over 6 is 2 per job and 5 jobs.
  jobs = Math.ceil(queryCount / queriesPerJob);

  let limit: Plan['limit'] = 'none';
  if (jobs >= queryCount) limit = 'queries';
  else if (byBudget <= MAX_JOBS) limit = 'database-size';
  else limit = 'job-cap';

  return {
    jobs,
    queriesPerJob,
    uploadBytes: jobs * databaseBytes + queryBytesTotal,
    limit,
  };
}

/** Split the query files into one group per job, in order. */
export function chunk<T>(items: readonly T[], perChunk: number): T[][] {
  if (perChunk <= 0) return items.length ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perChunk) out.push(items.slice(i, i + perChunk));
  return out;
}

// -------------------------------------------------------------- quoting

/**
 * Quote a value for a submit-file command.
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
 * Reject a file name that cannot safely be a transfer entry.
 *
 * Stricter than it has to be, on purpose. This name travels through a
 * submit-file comma list, a multipart Content-Disposition header and a
 * bash script; the set of characters that survive all three without a
 * rule I would have to remember is small, and a biologist can rename a
 * file. The app says so rather than silently mangling it.
 */
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('-') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

/**
 * Flatten a user-supplied string to something that can be carried
 * through a shell variable, `awk -v` and a JSON string without changing
 * meaning anywhere along the way.
 *
 * `awk -v` expands escape sequences in the value it is given, so a
 * database called `my\table.fa` arrives at awk as a real tab and lands
 * in results.json as a control character that JSON.parse rejects. The
 * page then shows nothing at all for a job that ran perfectly. Strip it
 * here, where the real name is still known, rather than in four places
 * downstream.
 */
export function displayText(value: string, max = 120): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || 'database'
  );
}

/** Single-quote a value for bash. Defence in depth: names reaching here
 *  have already passed isSafeFileName. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- script

export interface JobSpec {
  program: ProgramId;
  evalue: string;
  maxHits: number;
  /** The name the user gave the database, reported in results. */
  databaseLabel: string;
  databaseKind: DatabaseKind;
  /** The database's name in the sandbox. */
  databaseFile: string;
  /** Query file names for THIS job. */
  queryNames: string[];
  /** Groups every job of one search in the queue. */
  batchName: string;
  databaseBytes: number;
  queryBytes: number;
}

/**
 * The script the job runs, generated per job and uploaded with it.
 *
 * It is an uploaded input rather than a here-string in `arguments`
 * because a 100-line shell program inside a quoted submit-file value is
 * unreadable and one escaping mistake away from being a different
 * program. Only the output pre-creation stays in `arguments`, where it
 * runs before this file is even read.
 *
 * Everything interpolated below is either a fixed enum value, a number,
 * or a name that passed isSafeFileName -- and is single-quoted anyway.
 */
export function buildRunnerScript(spec: JobSpec): string {
  const program = programById(spec.program);
  const label = displayText(spec.databaseLabel);
  const evalue = isValidEvalue(spec.evalue) ? spec.evalue : '1e-5';
  const maxHits = isValidMaxHits(spec.maxHits) ? spec.maxHits : 25;
  const queries = spec.queryNames.filter(isSafeFileName);

  return `#!/bin/bash
# Generated by the BLAST site app. Edit the app, not this file.
set -u

PROGRAM=${shQuote(program.id)}
DBTYPE=${shQuote(program.dbType)}
DBFILE=${shQuote(spec.databaseFile)}
DBKIND=${shQuote(spec.databaseKind)}
DBLABEL=${shQuote(label)}
EVALUE=${shQuote(evalue)}
MAXHITS=${maxHits}
THREADS=${JOB_CPUS}
TOPN=${TOP_HITS}

QUERIES=(${queries.map(shQuote).join(' ')})

: > status.tsv
: > top.tsv
: > run.log
: > query.log

# The last few lines of a log, flattened into one line for a message.
# Backslashes go too: this text is passed to awk -v, which reads them as
# escape sequences.
logtail() { tail -n 3 "$1" 2>/dev/null | tr '\\n\\\\' '  '; }

# Writes results.json and exits. Called on every path, including every
# failure, so the page always has something to show.
#   $1 overall status, $2 message for the user, $3 exit code
finish() {
  awk -v status="$1" -v message="$2" \\
      -v program="$PROGRAM" -v dblabel="$DBLABEL" -v evalue="$EVALUE" \\
      -v maxhits="$MAXHITS" -v topn="$TOPN" '
    function esc(s) { gsub(/[\\001-\\037\\177]/, " ", s); gsub(/\\\\/, "\\\\\\\\", s); gsub(/"/, "\\\\\\"", s); return s }
    FNR == NR { qf[++nq] = $1; qs[nq] = $2; qh[nq] = $3 + 0; total += $3 + 0; next }
    { th[++nt] = $0 }
    END {
      printf "{\\"schema\\":1"
      printf ",\\"status\\":\\"%s\\"", esc(status)
      printf ",\\"message\\":\\"%s\\"", esc(message)
      printf ",\\"program\\":\\"%s\\"", esc(program)
      printf ",\\"database\\":\\"%s\\"", esc(dblabel)
      printf ",\\"evalue\\":\\"%s\\"", esc(evalue)
      printf ",\\"max_hits_per_sequence\\":%d", maxhits
      printf ",\\"total_hits\\":%d", total
      printf ",\\"queries\\":["
      for (i = 1; i <= nq; i++)
        printf "%s{\\"file\\":\\"%s\\",\\"status\\":\\"%s\\",\\"hits\\":%d}", (i > 1 ? "," : ""), esc(qf[i]), esc(qs[i]), qh[i]
      printf "]"
      printf ",\\"top_hits\\":["
      for (i = 1; i <= nt; i++) {
        n = split(th[i], c, "\\t")
        if (n < 13) continue
        printf "%s{\\"query_file\\":\\"%s\\",\\"query\\":\\"%s\\",\\"subject\\":\\"%s\\",\\"identity\\":%s,\\"length\\":%d,\\"evalue\\":\\"%s\\",\\"bits\\":%s}", \\
          (i > 1 ? "," : ""), esc(c[1]), esc(c[2]), esc(c[3]), c[4] + 0, c[5] + 0, esc(c[12]), c[13] + 0
      }
      printf "]"
      printf ",\\"top_hits_truncated\\":%s", (total > topn ? "true" : "false")
      printf "}\\n"
    }
  ' status.tsv top.tsv > results.json
  exit "$3"
}

# One line of plain-language advice per failure. "It did not work" is
# not a message; "ask your administrator for BLAST+" is.
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  finish error "The compute node that ran this job does not have $1 installed. Ask your system administrator to make the BLAST+ tools available on the pool, then run this search again." 70
}

need "$PROGRAM"

printf 'query_file\\tquery_id\\tsubject_id\\tpct_identity\\talignment_length\\tmismatches\\tgap_opens\\tq_start\\tq_end\\ts_start\\ts_end\\tevalue\\tbit_score\\n' > hits.tsv

# ---- the database, prepared once per job and then reused by every query
DBDIR=blastdb
mkdir -p "$DBDIR"
DB=

if [ ! -s "$DBFILE" ]; then
  finish error "The reference database did not arrive with this job, or arrived empty. Submit the search again; if it keeps happening the database file may be too large to upload." 65
fi

case "$DBKIND" in
  blastdb-archive)
    if ! tar -xf "$DBFILE" -C "$DBDIR" >> run.log 2>&1; then
      finish error "The database archive could not be unpacked. It should be a .tar.gz of a BLAST database directory, or a plain FASTA file." 65
    fi
    index=$(find "$DBDIR" -maxdepth 4 \\( -name '*.nin' -o -name '*.pin' -o -name '*.nal' -o -name '*.pal' \\) 2>/dev/null | sort | head -n 1)
    if [ -n "$index" ]; then
      DB="\${index%.*}"
      # Volume files are named db.00.nin, db.01.nin ... strip the volume.
      case "$DB" in *.[0-9][0-9]) DB="\${DB%.*}" ;; esac
    else
      fasta=$(find "$DBDIR" -maxdepth 4 -type f \\( -name '*.fa' -o -name '*.fasta' -o -name '*.fna' -o -name '*.faa' \\) 2>/dev/null | sort | head -n 1)
      if [ -z "$fasta" ]; then
        finish error "No BLAST database and no FASTA file were found inside the archive. Upload either a prepared BLAST database (the .nin/.nsq files) or a FASTA file and let the job prepare it." 65
      fi
      need makeblastdb
      if ! makeblastdb -in "$fasta" -dbtype "$DBTYPE" -out "$DBDIR/reference" -title reference >> run.log 2>&1; then
        finish error "Preparing the database from $(basename "$fasta") failed. Check that it is $DBTYPE sequence in FASTA format. Details: $(logtail run.log)" 65
      fi
      DB="$DBDIR/reference"
    fi
    ;;
  fasta-gz|fasta)
    if [ "$DBKIND" = fasta-gz ]; then
      if ! gunzip -c "$DBFILE" > "$DBDIR/reference.fasta" 2>> run.log; then
        finish error "The database file could not be decompressed. It ends in .gz but is not a gzip file." 65
      fi
    else
      cp "$DBFILE" "$DBDIR/reference.fasta"
    fi
    need makeblastdb
    if ! makeblastdb -in "$DBDIR/reference.fasta" -dbtype "$DBTYPE" -out "$DBDIR/reference" -title reference >> run.log 2>&1; then
      finish error "The reference database could not be prepared. BLAST expects $DBTYPE sequence in FASTA format; this file does not look like that. Details: $(logtail run.log)" 65
    fi
    DB="$DBDIR/reference"
    ;;
esac

# ---- the queries
failed=0
for q in "\${QUERIES[@]}"; do
  if [ ! -s "$q" ]; then
    printf '%s\\tempty\\t0\\n' "$q" >> status.tsv
    continue
  fi
  if "$PROGRAM" -query "$q" -db "$DB" -outfmt 6 -evalue "$EVALUE" \\
       -max_target_seqs "$MAXHITS" -num_threads "$THREADS" > one.tsv 2>> query.log; then
    awk -v f="$q" 'BEGIN { OFS = "\\t" } { print f, $0 }' one.tsv >> hits.tsv
    printf '%s\\tok\\t%d\\n' "$q" "$(wc -l < one.tsv | tr -d ' ')" >> status.tsv
  else
    failed=$((failed + 1))
    printf '%s\\tfailed\\t0\\n' "$q" >> status.tsv
  fi
  rm -f one.tsv
done

# The best TOPN rows by e-value, for the page to draw. hits.tsv keeps
# the full set for download.
tail -n +2 hits.tsv | sort -g -k12,12 2>/dev/null | head -n "$TOPN" > top.tsv
# sort -g is not universal (busybox has no -g). Unsorted beats empty.
if [ ! -s top.tsv ] && [ "$(wc -l < hits.tsv | tr -d ' ')" -gt 1 ]; then
  tail -n +2 hits.tsv | head -n "$TOPN" > top.tsv
fi

if [ "$failed" -gt 0 ]; then
  finish partial "$failed of \${#QUERIES[@]} sequence files could not be searched; the rest are below. The usual cause is a file that is not FASTA, or that is protein where DNA was expected. Details: $(logtail query.log)" 1
fi

finish ok "" 0
`;
}

// ----------------------------------------------------------- submit file

/** Memory a job asks for. BLAST's appetite tracks the database. */
export function requestMemoryMB(databaseBytes: number): number {
  const dbMB = databaseBytes / (1024 * 1024);
  return Math.min(16384, Math.max(2048, Math.ceil(2048 + dbMB)));
}

/** Disk: the archive, the unpacked copy, the index and the output. */
export function requestDiskKB(databaseBytes: number, queryBytes: number): number {
  const kb = ((databaseBytes + queryBytes) * 4) / 1024;
  return Math.min(100 * 1024 * 1024, Math.max(2 * 1024 * 1024, Math.ceil(kb)));
}

export function buildSubmitFile(spec: JobSpec): string {
  const queries = spec.queryNames.filter(isSafeFileName).map(quote);
  const inputs = [quote(RUNNER_FILE), quote(spec.databaseFile), ...queries];

  // Note the `: >` before anything else: a declared output file that is
  // missing at the end holds the job for a file-transfer error, which
  // says nothing about what actually went wrong. Doing it here, in
  // `arguments`, rather than inside the runner script means even a
  // broken runner script fails as itself.
  const prepare = OUTPUT_FILES.map((f) => `: > ${f}`).join('; ');

  return [
    `executable = /usr/bin/env`,
    `transfer_executable = false`,
    `arguments = "bash -c '${prepare}; exec bash ${RUNNER_FILE}'"`,
    ``,
    `request_cpus = ${JOB_CPUS}`,
    `request_memory = ${requestMemoryMB(spec.databaseBytes)}`,
    `request_disk = ${requestDiskKB(spec.databaseBytes, spec.queryBytes)}`,
    ``,
    `should_transfer_files = YES`,
    `when_to_transfer_output = ON_EXIT`,
    `transfer_input_files = ${inputs.join(',')}`,
    ``,
    `output = stdout.txt`,
    `error = stderr.txt`,
    // Declared, so they come back -- and created at the start of the
    // job, so declaring them cannot turn a failure into a hold.
    `transfer_output_files = ${OUTPUT_FILES.join(',')}`,
    ``,
    // The batch name is how the app finds one search's jobs later
    // without keeping a database: the queue is the record.
    `JobBatchName = ${quote(spec.batchName)}`,
    ``,
    `queue 1`,
    ``,
  ].join('\n');
}

/** A batch name that groups one search's jobs. Safe by construction. */
export function batchNameFor(program: ProgramId, when = new Date()): string {
  const stamp = when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `blast-${program}-${stamp}`;
}

/** True for any batch name this app produces, for the queue constraint. */
export const BATCH_PREFIX = 'blast-';
