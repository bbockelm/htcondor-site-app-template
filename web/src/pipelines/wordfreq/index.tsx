// Word frequency: one text file in, a sortable table out.
//
// The simplest of the three, and the one to read first. It shows the
// whole arc -- drop a file, submit, upload, poll, read a structured
// result -- with nothing science-specific in the way.
//
// The idea worth stealing: the program the job runs is GENERATED here
// and shipped as an input file, so no user-supplied text ever reaches
// the submit file. See wordfreq.ts.

import { isSafeFileName } from '../../lib/submit';
import type { ControlsProps, Pipeline, PlanResult, ResultsProps } from '../types';
import { BATCH_NAME, buildSubmitFile } from './submit';
import { Results as WordFreqResults } from './Results';
import {
  DEFAULT_OPTIONS,
  INPUT_NAME,
  PROGRAM_NAME,
  buildProgram,
  type CountOptions,
} from './wordfreq';

function Controls({ options, onChange, busy }: ControlsProps<CountOptions>) {
  return (
    <fieldset disabled={busy}>
      <label>
        Ignore words shorter than
        <input
          type="number"
          min={1}
          max={20}
          value={options.minLength}
          onChange={(e) => onChange({ ...options, minLength: Number(e.target.value) })}
        />
      </label>
      <label>
        Show the top
        <input
          type="number"
          min={1}
          max={1000}
          value={options.topN}
          onChange={(e) => onChange({ ...options, topN: Number(e.target.value) })}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={options.foldCase}
          onChange={(e) => onChange({ ...options, foldCase: e.target.checked })}
        />
        Treat “The” and “the” as one word
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={options.skipCommonWords}
          onChange={(e) => onChange({ ...options, skipCommonWords: e.target.checked })}
        />
        Skip common words
      </label>
    </fieldset>
  );
}

function plan(files: File[], options: CountOptions): PlanResult {
  const file = files[0];
  if (!file) {
    return { kind: 'error', message: 'Drop a text file to count.' };
  }
  // The user's name for the file never reaches the submit file -- it
  // is uploaded as INPUT_NAME -- but it is still checked, because it
  // goes into a multipart filename on the way there.
  if (!isSafeFileName(file.name)) {
    return {
      kind: 'error',
      message: `Rename “${file.name}”: letters, digits, dot, dash and underscore only.`,
    };
  }
  return {
    kind: 'job',
    batchName: BATCH_NAME,
    submitFile: buildSubmitFile(file.name, file.size),
    uploads: [
      // The generated awk program, as a file the job receives.
      { name: PROGRAM_NAME, file: programFile(file.name, options) },
      { name: INPUT_NAME, file },
    ],
  };
}

/** The awk program as an uploadable file. */
function programFile(label: string, options: CountOptions): File {
  return new File([buildProgram(label, options)], PROGRAM_NAME, { type: 'text/plain' });
}

function Results({ job }: ResultsProps) {
  return <WordFreqResults jobId={`${job.ClusterId}.${job.ProcId}`} />;
}

export const wordFrequency: Pipeline<CountOptions> = {
  id: 'wordfreq',
  name: 'Word frequency',
  summary: 'Count the words in a text file and show the most common.',
  accept: '.txt,.text,.md,text/plain',
  multiple: false,
  inputLabel: 'a text file',
  defaults: DEFAULT_OPTIONS,
  Controls,
  plan,
  Results,
};
