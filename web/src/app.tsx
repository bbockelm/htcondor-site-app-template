// A BLAST sequence search, as a lab runs it: one reference database,
// many query files, one job per group of queries.
//
// The one number this page exists to put in front of the user before
// they commit is how much data the submission will push to the access
// point. See the header of lib/submit.ts for why that number is what it
// is; the short version is that there is no shared staging area in the
// API, so the database travels once per job and the job count is a
// budget decision.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  isFinished,
  isReceivingFiles,
  jobStatusLabel,
  JobStatus,
  type Job,
} from './lib/api';
import {
  BATCH_PREFIX,
  EVALUES,
  MAX_DATABASE_BYTES,
  MAX_HITS,
  OUTPUT_FILES,
  PROGRAMS,
  RUNNER_FILE,
  batchNameFor,
  buildRunnerScript,
  buildSubmitFile,
  chunk,
  databaseFileName,
  databaseKind,
  isSafeFileName,
  planSubmission,
  programById,
  type ProgramId,
} from './lib/submit';
import { app, type Identity } from './lib/htcondor';
import { Dropzone, formatSize } from './components/Dropzone';

const HITS_FILE = OUTPUT_FILES[1];

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [database, setDatabase] = useState<File[]>([]);
  const [queries, setQueries] = useState<File[]>([]);
  const [program, setProgram] = useState<ProgramId>('blastn');
  const [evalue, setEvalue] = useState<string>('1e-5');
  const [maxHits, setMaxHits] = useState<number>(25);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, []);

  // The queue is the record: this app keeps no database of its own, so
  // a reload, a second browser or a colleague's machine all see the
  // same searches.
  const refresh = useCallback(async () => {
    try {
      let found: Job[];
      try {
        found = await api.jobs(`regexp("^${BATCH_PREFIX}", JobBatchName)`);
      } catch (e) {
        // A server that will not take this constraint is not a reason
        // to show the user nothing; ask for everything of theirs and
        // sort it out here.
        if (!(e instanceof ApiError) || e.status >= 500) throw e;
        found = await api.jobs();
      }
      setJobs(found.filter((j) => String(j.JobBatchName ?? '').startsWith(BATCH_PREFIX)));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const db = database[0] ?? null;
  const queryBytes = queries.reduce((n, f) => n + f.size, 0);
  const badNames = queries.filter((f) => !isSafeFileName(f.name));

  const plan = useMemo(
    () =>
      planSubmission({
        databaseBytes: db?.size ?? 0,
        queryBytesTotal: queryBytes,
        queryCount: queries.length,
      }),
    [db?.size, queryBytes, queries.length],
  );

  const blocker = whyNotYet({ db, queryCount: queries.length, badNames: badNames.length });

  async function run() {
    if (!db || blocker) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress(null);

    const batchName = batchNameFor(program);
    const groups = chunk(queries, plan.queriesPerJob);
    const dbFile = databaseFileName(db.name);
    let started = 0;

    try {
      for (const [i, group] of groups.entries()) {
        setProgress(
          `Sending job ${i + 1} of ${groups.length}. The database goes with each one, so this is the slow part.`,
        );

        const spec = {
          program,
          evalue,
          maxHits,
          databaseLabel: db.name,
          databaseKind: databaseKind(db.name),
          databaseFile: dbFile,
          queryNames: group.map((f) => f.name),
          batchName,
          databaseBytes: db.size,
          queryBytes: group.reduce((n, f) => n + f.size, 0),
        };

        // Submit first, upload second. In between the job sits HELD
        // (HoldReasonCode 16, SpoolingInput) waiting for these files --
        // which is why the job list calls that state "Receiving its
        // files" rather than "Stopped".
        const { job_ids } = await api.submit(buildSubmitFile(spec));
        const jobId = job_ids[0];
        if (!jobId) throw new Error('The access point accepted the job but did not say which.');

        const runner = new File([buildRunnerScript(spec)], RUNNER_FILE, { type: 'text/plain' });
        await api.uploadInputs(jobId, [
          { name: RUNNER_FILE, file: runner },
          { name: dbFile, file: db },
          ...group.map((f) => ({ name: f.name, file: f })),
        ]);
        started += 1;
        await refresh();
      }

      setNotice(
        `${started} ${started === 1 ? 'job is' : 'jobs are'} on their way. They appear below as they start.`,
      );
      setQueries([]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        started === 0
          ? detail
          : `${detail} — ${started} of ${groups.length} jobs were started and are still running; the rest were not submitted. The ones that did start are listed below.`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
      void refresh();
    }
  }

  const searches = groupSearches(jobs);

  return (
    <main>
      <h1>{app.name}</h1>
      <p className="lede">
        {me?.authenticated
          ? `Search your sequences against your own reference database. Signed in as ${me.username}.`
          : 'Loading…'}
      </p>

      {error && (
        <div className="notice error" role="alert" data-testid="error">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status" data-testid="submitted">
          {notice}
        </div>
      )}
      {progress && (
        <div className="notice" role="status" data-testid="progress">
          {progress}
        </div>
      )}

      <fieldset>
        <legend>Reference database</legend>
        <p className="meta hint">
          One file: a FASTA file of the sequences to search against, or a .tar.gz of a BLAST
          database you have already built. Everything you search gets compared to this.
        </p>
        <Dropzone
          files={database}
          onChange={setDatabase}
          disabled={busy}
          multiple={false}
          label="Drop the reference database here, or choose a file"
          problem={(f) =>
            f.size > MAX_DATABASE_BYTES
              ? `Too large to upload through this page (${formatSize(f.size)}). Ask your facilitator to put a database this size on the access point.`
              : null
          }
        />
      </fieldset>

      <fieldset>
        <legend>Sequences to search for</legend>
        <p className="meta hint">
          One or many FASTA files. Each is searched against the database above.
        </p>
        <Dropzone
          files={queries}
          onChange={setQueries}
          disabled={busy}
          label="Drop your sequence files here, or choose files"
          problem={(f) =>
            isSafeFileName(f.name)
              ? null
              : 'Rename this file before uploading: use only letters, numbers, dots, dashes and underscores.'
          }
        />
      </fieldset>

      <fieldset>
        <legend>Search settings</legend>
        <label>
          <span>What kind of search</span>
          <select
            value={program}
            onChange={(e) => setProgram(e.target.value as ProgramId)}
            disabled={busy}
            data-testid="program"
          >
            {PROGRAMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>How good a match has to be</span>
          <select
            value={evalue}
            onChange={(e) => setEvalue(e.target.value)}
            disabled={busy}
            data-testid="evalue"
          >
            {EVALUES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Most matches to keep per sequence</span>
          <select
            value={maxHits}
            onChange={(e) => setMaxHits(Number(e.target.value))}
            disabled={busy}
            data-testid="max-hits"
          >
            {MAX_HITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <div className="plan" data-testid="plan">
        {blocker ?? <PlanSentence db={db!} plan={plan} queryCount={queries.length} />}
      </div>

      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || blocker !== null}
        data-testid="submit"
      >
        {busy ? 'Sending…' : `Start the search`}
      </button>

      <h2>Your searches</h2>
      {searches.length === 0 ? (
        <p className="meta">Nothing yet. Searches you start appear here and stay until they age
          out of the queue.</p>
      ) : (
        <ul className="searches" data-testid="search-list">
          {searches.map((s) => (
            <Search key={s.name} search={s} busy={busy} onChanged={refresh} />
          ))}
        </ul>
      )}
    </main>
  );
}

// ------------------------------------------------------------ the plan

function whyNotYet(x: { db: File | null; queryCount: number; badNames: number }): string | null {
  if (!x.db) return 'Add a reference database to search against.';
  if (x.db.size > MAX_DATABASE_BYTES)
    return `That database is ${formatSize(x.db.size)}, which is more than this page can upload. A database that size should live on the access point already — ask your facilitator to stage it for you.`;
  if (x.db.size === 0) return 'That database file is empty.';
  if (x.queryCount === 0) return 'Add at least one file of sequences to search for.';
  if (x.badNames > 0)
    return `Rename ${x.badNames === 1 ? 'the file marked above' : `the ${x.badNames} files marked above`} before starting: names can only contain letters, numbers, dots, dashes and underscores.`;
  return null;
}

function PlanSentence({
  db,
  plan,
  queryCount,
}: {
  db: File;
  plan: ReturnType<typeof planSubmission>;
  queryCount: number;
}) {
  const per = plan.queriesPerJob;
  return (
    <>
      <strong>
        {queryCount} {queryCount === 1 ? 'file' : 'files'} in {plan.jobs}{' '}
        {plan.jobs === 1 ? 'job' : 'jobs'}
      </strong>
      , {per === 1 ? 'one file each' : `up to ${per} files each`}.{' '}
      {/* The cost, stated before the button rather than discovered after
          it. The database is uploaded once per job because the API has
          nowhere to put a file that many jobs can share. */}
      Your database ({formatSize(db.size)}) is sent once per job, so this uploads{' '}
      <strong>{formatSize(plan.uploadBytes)}</strong> in total.
      {plan.limit === 'database-size' && (
        <>
          {' '}
          It is {plan.jobs} jobs rather than more because of the database&rsquo;s size — a smaller
          database would spread across more machines and finish sooner.
        </>
      )}
      {plan.limit === 'job-cap' && <> That is this app&rsquo;s limit of {plan.jobs} jobs at once.</>}
    </>
  );
}

// -------------------------------------------------------- the job lists

interface SearchGroup {
  name: string;
  program: string;
  startedAt: number | null;
  jobs: Job[];
}

function groupSearches(jobs: Job[]): SearchGroup[] {
  const byName = new Map<string, Job[]>();
  for (const j of jobs) {
    const name = String(j.JobBatchName ?? '');
    byName.set(name, [...(byName.get(name) ?? []), j]);
  }
  return Array.from(byName, ([name, js]) => ({
    name,
    program: name.split('-')[1] ?? 'blast',
    startedAt: js.reduce<number | null>(
      (min, j) => (j.QDate && (min === null || j.QDate < min) ? j.QDate : min),
      null,
    ),
    jobs: js.sort((a, b) => a.ClusterId - b.ClusterId || a.ProcId - b.ProcId),
  })).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

function Search({
  search,
  busy,
  onChanged,
}: {
  search: SearchGroup;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const done = search.jobs.filter(isFinished).length;
  const live = search.jobs.filter((j) => !isFinished(j) && !isReceivingFiles(j));
  const allDone = done === search.jobs.length;

  async function stop() {
    for (const j of live) {
      try {
        await api.hold(`${j.ClusterId}.${j.ProcId}`);
      } catch {
        /* another job of the same search may already have ended */
      }
    }
    await onChanged();
  }

  return (
    <li className="search">
      <div className="search-head">
        <span className="name">
          {programById(search.program as ProgramId).label.replace(/\s*\(.*\)$/, '')}
          <span className="meta"> · {new Date((search.startedAt ?? 0) * 1000).toLocaleString()}</span>
        </span>
        <span className="meta" data-testid="search-progress">
          {done} of {search.jobs.length} finished
        </span>
        {!allDone && live.length > 0 && (
          // "Stop", not "Cancel": this holds the jobs, which leaves
          // them in the queue where they can be released. DELETE
          // /jobs/{id} answers 501, so a Cancel button could not work.
          <button type="button" className="secondary" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        )}
        <button type="button" className="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Details'}
        </button>
      </div>

      <ul className="jobs">
        {search.jobs.map((j) => {
          const id = `${j.ClusterId}.${j.ProcId}`;
          return (
            <li key={id}>
              <span className="name">
                Job {id} <span className="meta">{jobStatusLabel(j)}</span>
              </span>
              {j.JobStatus === JobStatus.Completed && (
                <a href={api.fileUrl(id, HITS_FILE)} download>
                  All matches (TSV)
                </a>
              )}
              {j.JobStatus === JobStatus.Held && !isReceivingFiles(j) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void api.release(id).then(onChanged)}
                >
                  Try again
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {open && <Results jobs={search.jobs} />}
    </li>
  );
}

// ----------------------------------------------------------- the results

interface ResultsFile {
  status?: string;
  message?: string;
  database?: string;
  program?: string;
  total_hits?: number;
  queries?: { file: string; status: string; hits: number }[];
  top_hits?: {
    query_file: string;
    query: string;
    subject: string;
    identity: number;
    length: number;
    evalue: string;
    bits: number;
  }[];
  top_hits_truncated?: boolean;
}

/**
 * Reads results.json out of each finished job and draws one table.
 *
 * Only on demand, and only for finished jobs: there are up to 40 of
 * them and each one is a request.
 */
function Results({ jobs }: { jobs: Job[] }) {
  const [files, setFiles] = useState<{ id: string; data: ResultsFile | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const finishedIds = jobs
    .filter((j) => j.JobStatus === JobStatus.Completed)
    .map((j) => `${j.ClusterId}.${j.ProcId}`)
    .join(',');
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    const ids = finishedIds ? finishedIds.split(',') : [];
    Promise.all(
      ids.map(async (id) => {
        try {
          const text = await api.jobFileText(id, OUTPUT_FILES[0]);
          return { id, data: text.trim() ? (JSON.parse(text) as ResultsFile) : null };
        } catch {
          // A finished job whose sandbox is gone, or an empty
          // pre-created file. Neither is worth an error banner.
          return { id, data: null };
        }
      }),
    ).then((r) => {
      if (!cancelled.current) {
        setFiles(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled.current = true;
    };
  }, [finishedIds]);

  if (!finishedIds) return <p className="meta">No job has finished yet.</p>;
  if (loading) return <p className="meta">Reading results…</p>;

  const problems = files
    .map((f) => f.data)
    .filter((d): d is ResultsFile => !!d && !!d.message && d.status !== 'ok');
  const perQuery = files.flatMap((f) => f.data?.queries ?? []);
  const hits = files
    .flatMap((f) => f.data?.top_hits ?? [])
    .sort((a, b) => Number(a.evalue) - Number(b.evalue))
    .slice(0, 50);
  const total = files.reduce((n, f) => n + (f.data?.total_hits ?? 0), 0);
  const searched = perQuery.filter((q) => q.status === 'ok').length;

  return (
    <div className="results">
      {problems.map((p, i) => (
        <p key={i} className="notice error" role="alert">
          {p.message}
        </p>
      ))}

      <p className="meta">
        {total} {total === 1 ? 'match' : 'matches'} across {searched} of {perQuery.length} sequence
        files.
        {perQuery.some((q) => q.hits === 0 && q.status === 'ok') && (
          <> Files with no match at all: {perQuery.filter((q) => q.hits === 0).length}.</>
        )}
      </p>

      {hits.length === 0 ? (
        <p className="meta">
          Nothing matched at this threshold. Try &ldquo;Weak matches too&rdquo; and search again.
        </p>
      ) : (
        <table className="hits" data-testid="hits-table">
          <thead>
            <tr>
              <th>Sequence file</th>
              <th>Query</th>
              <th>Match</th>
              <th>Identity</th>
              <th>Length</th>
              <th>E-value</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={i}>
                <td>{h.query_file}</td>
                <td>{h.query}</td>
                <td>{h.subject}</td>
                <td>{h.identity}%</td>
                <td>{h.length}</td>
                <td>{h.evalue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > hits.length && (
        <p className="meta">
          Showing the {hits.length} best. Download the TSV above for the full set.
        </p>
      )}
    </div>
  );
}
