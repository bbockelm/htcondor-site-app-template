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
import { astro } from './astro';
import { blast } from './blast';
import { wordFrequency } from './wordfreq';

/**
 * A pipeline whose options type is its own business.
 *
 * Each pipeline parameterises Pipeline<O> with whatever it keeps, and
 * the shell holds that value without looking inside. A list of
 * different ones cannot be typed without an escape hatch, so it is
 * taken once, here, rather than at every use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPipeline = Pipeline<any>;

export const PIPELINES: AnyPipeline[] = [wordFrequency, astro, blast];

export function pipelineById(id: string): AnyPipeline | undefined {
  return PIPELINES.find((p) => p.id === id);
}
