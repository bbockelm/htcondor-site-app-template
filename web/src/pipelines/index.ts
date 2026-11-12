// The pipelines this app offers.
//
// Adding one is adding a file here and a line below. Removing one is
// deleting the line -- nothing on the server knows which pipelines
// exist, so the queue keeps whatever is already running either way.
//
// Three worked examples, in increasing order of how much they ask of
// HTCondor:
//
//   wordfreq  one file in, one job, a structured result out
//   astro     many files in, one job each, binary output
//   blast     a large shared input and many queries, as a DAG
//
// Read wordfreq first. Read blast when you have an input every job
// needs and do not want to upload it per job.

import type { Pipeline } from './types';
import { wordFrequency } from './wordfreq';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each
// pipeline keeps its own options type; the shell holds them opaquely.
export const PIPELINES: Pipeline<any>[] = [wordFrequency];

export function pipelineById(id: string): Pipeline<any> | undefined {
  return PIPELINES.find((p) => p.id === id);
}
