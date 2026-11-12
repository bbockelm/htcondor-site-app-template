// BLAST: a shared database and many queries, as a DAG.
//
// Read pipelines/blast/dag.ts for the part worth copying. This file is
// the controls, the validation, and turning what the user dropped into
// a workflow.

import { isSafeFileName } from '../../lib/submit';
import type { ControlsProps, Pipeline, PlanResult, ResultsProps } from '../types';
import {
  EVALUES,
  MAX_DATABASE_BYTES,
  MAX_HITS,
  PROGRAMS,
  QUERIES_PER_NODE,
  RUNNER_FILE,
  batchNameFor,
  buildRunnerScript,
  databaseFileName,
  databaseKind,
  programById,
  type ProgramId,
} from './blast';
import { DAG_NAME, buildDagFile, buildNodeFiles, planNodes } from './dag';
import { Results as BlastResults } from './Results';

export interface BlastOptions {
  program: ProgramId;
  evalue: string;
  maxHits: number;
  /**
   * Which dropped file is the database. The rest are queries.
   *
   * By name rather than by index, because the dropzone reorders by
   * name and an index would quietly come to mean a different file.
   */
  databaseName: string | null;
}

const DEFAULTS: BlastOptions = {
  program: 'blastn',
  evalue: '1e-5',
  maxHits: 25,
  databaseName: null,
};

function Controls({ options, onChange, busy }: ControlsProps<BlastOptions>) {
  return (
    <fieldset disabled={busy}>
      <label>
        Search
        <select
          value={options.program}
          onChange={(e) => onChange({ ...options, program: e.target.value as ProgramId })}
          data-testid="blast-program"
        >
          {PROGRAMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Report matches
        <select
          value={options.evalue}
          onChange={(e) => onChange({ ...options, evalue: e.target.value })}
          data-testid="blast-evalue"
        >
          {EVALUES.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Hits per sequence
        <select
          value={options.maxHits}
          onChange={(e) => onChange({ ...options, maxHits: Number(e.target.value) })}
          data-testid="blast-maxhits"
        >
          {MAX_HITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/**
 * The largest dropped file is the database unless the user said
 * otherwise. It is right nearly always -- a database dwarfs a read
 * file -- and being wrong is visible immediately in the summary rather
 * than an hour later in the results.
 */
export function pickDatabase(files: File[], chosen: string | null): File | undefined {
  if (chosen) {
    const named = files.find((f) => f.name === chosen);
    if (named) return named;
  }
  return files.slice().sort((a, b) => b.size - a.size)[0];
}

function plan(files: File[], options: BlastOptions): PlanResult {
  if (files.length < 2) {
    return {
      kind: 'error',
      message: 'Drop a database and at least one query file. The largest file is taken as the database.',
    };
  }
  const database = pickDatabase(files, options.databaseName);
  if (!database) {
    return { kind: 'error', message: 'No database among the dropped files.' };
  }
  if (database.size > MAX_DATABASE_BYTES) {
    return {
      kind: 'error',
      message:
        `“${database.name}” is larger than this form will push (${Math.round(MAX_DATABASE_BYTES / 1024 ** 3)} GB). ` +
        'A database that size belongs on the access point, staged by a facilitator.',
    };
  }

  const queries = files.filter((f) => f !== database);
  const unsafe = queries.filter((f) => !isSafeFileName(f.name));
  if (unsafe.length) {
    return {
      kind: 'error',
      message: `Rename ${unsafe.map((f) => `“${f.name}”`).join(', ')}: letters, digits, dot, dash and underscore only.`,
    };
  }
  // The spool is one flat directory, so two queries cannot share a
  // name. Caught here rather than at run time, where it is one node
  // silently searching the other's file.
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.name)) {
      return {
        kind: 'error',
        message: `Two query files are called “${q.name}”. The workflow's directory is flat, so each needs its own name.`,
      };
    }
    seen.add(q.name);
  }

  const dbFile = databaseFileName(database.name);
  const nodes = planNodes(
    queries.map((f) => f.name),
    queries.map((f) => f.size),
    {
      program: options.program,
      evalue: options.evalue,
      maxHits: options.maxHits,
      databaseLabel: database.name,
      databaseKind: databaseKind(database.name),
      databaseFile: dbFile,
      databaseBytes: database.size,
    },
    QUERIES_PER_NODE,
  );

  return {
    kind: 'dag',
    batchName: batchNameFor(options.program),
    dagFile: buildDagFile(nodes),
    nodeFiles: {
      ...buildNodeFiles(nodes),
      // The runner is text, so it rides as a form value rather than a
      // file part. Same spool either way.
      [RUNNER_FILE]: buildRunnerScript(nodes[0].spec),
    },
    // Uploaded ONCE, with the workflow. Every node reads it from the
    // spool by this name.
    uploads: [
      { name: dbFile, file: database },
      ...queries.map((f) => ({ name: f.name, file: f })),
    ],
  };
}

function Results({ job }: ResultsProps) {
  return <BlastResults job={job} />;
}

export const blast: Pipeline<BlastOptions> = {
  id: 'blast',
  name: 'BLAST search',
  summary:
    'Search many query files against one database. The database is uploaded once, not once per job.',
  multiple: true,
  inputLabel: 'a database and your query files',
  defaults: DEFAULTS,
  Controls,
  plan,
  Results,
};

export { DAG_NAME, programById };
