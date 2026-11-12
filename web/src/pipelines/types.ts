// What a pipeline has to provide, and what the app shell does for it.
//
// The shell owns everything that is the same whatever science you are
// running: who you are, the dropzone, the submit-then-upload-then-poll
// sequence, the job list, the error handling. A pipeline owns the four
// things that are genuinely its own -- what files it takes, what
// controls it offers, what submit file it produces, and how its
// results should be read.
//
// Three are implemented here, in pipelines/. They are worked examples,
// not a framework: a lab building their own deletes the two they do
// not want and edits the third. Nothing on the server knows this
// interface exists.

import type { JSX } from 'react';
import type { Job } from '../lib/api';

/** One file to upload into a job's sandbox, under a chosen name. */
export interface Upload {
  /** The name the job will see. Keep these fixed; see submit.ts. */
  name: string;
  file: File;
}

/** A plain one-job submission. */
export interface JobPlan {
  kind: 'job';
  submitFile: string;
  uploads: Upload[];
  /** Shown in the job list, and how the app finds its own jobs again. */
  batchName: string;
}

/**
 * A DAG submission: the shared inputs are spooled ONCE and the node
 * jobs are submitted by DAGMan from that sandbox.
 *
 * This is the answer to "every job needs the same 2 GB database". A
 * plain `queue N` uploads it per proc; a DAG uploads it once. See
 * AGENTS.md, which explains why, and pipelines/blast, which does it.
 */
export interface DagPlan {
  kind: 'dag';
  /** The .dag file. */
  dagFile: string;
  /** Submit files for the nodes, by file name. */
  nodeFiles: Record<string, string>;
  /** Spooled once, with the DAG. */
  uploads: Upload[];
  batchName: string;
}

export type Plan = JobPlan | DagPlan;

/** Why a pipeline will not run with what it was given. */
export interface PlanError {
  kind: 'error';
  /** Said to the user. Name the thing to change, not the rule broken. */
  message: string;
}

export type PlanResult = Plan | PlanError;

export function isPlanError(r: PlanResult): r is PlanError {
  return r.kind === 'error';
}

/** Props the shell hands a pipeline's controls. */
export interface ControlsProps<O> {
  options: O;
  onChange: (next: O) => void;
  /** True while a submission is in flight; disable inputs. */
  busy: boolean;
}

/** Props the shell hands a pipeline's results view. */
export interface ResultsProps {
  job: Job;
  /** Fetches one of the job's output files as text. */
  readOutput: (name: string) => Promise<string>;
}

/**
 * A pipeline. `O` is whatever that pipeline keeps in its own options;
 * the shell holds it without looking inside.
 */
export interface Pipeline<O = unknown> {
  id: string;
  name: string;
  /** One line, shown under the picker. */
  summary: string;
  /** `accept` for the file input, e.g. '.fits,.fit'. */
  accept?: string;
  /** Whether more than one file is meaningful. */
  multiple: boolean;
  /** What the dropzone should say it wants. */
  inputLabel: string;
  defaults: O;
  Controls: (p: ControlsProps<O>) => JSX.Element;
  /** Turn the dropped files and the chosen options into a submission. */
  plan: (files: File[], options: O) => PlanResult;
  /** Read this pipeline's output. */
  Results: (p: ResultsProps) => JSX.Element;
}
