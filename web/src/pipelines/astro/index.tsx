// FITS previews: astronomical images in, statistics and a PNG out.
//
// The example with BINARY output. The job writes results.json for the
// numbers and preview.png for the picture, and the page shows the
// picture by URL rather than reading its bytes -- which is what the
// job's file endpoint is for.
//
// Two jobs shapes from one pipeline: "each" makes a preview per image,
// "composite" combines three into a colour image, so the planner has
// to produce either N jobs or one. The shell submits one plan, so
// "each" is a single submit file with `queue` over a list.

import type { ControlsProps, Pipeline, PlanResult, ResultsProps } from '../types';
import {
  CHANNELS,
  CLIPS,
  DEFAULT_OPTIONS,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  SIZES,
  STRETCHES,
  formatBytes,
  isSafeFileName,
  looksLikeFits,
  type Options,
} from './fits';
import { RUNNER_FILE, buildRunner, runnerConfig } from './runner';
import { batchNameFor, buildSubmitFile } from './submit';
import { Results as FitsResults } from './Results';

function Controls({ options, onChange, busy }: ControlsProps<Options>) {
  return (
    <fieldset disabled={busy}>
      <label>
        Make
        <select
          value={options.mode}
          onChange={(e) => onChange({ ...options, mode: e.target.value as Options['mode'] })}
          data-testid="fits-mode"
        >
          <option value="each">A preview of each image</option>
          <option value="composite">One colour composite from three</option>
        </select>
      </label>
      <label>
        Brightness scale
        <select
          value={options.stretch}
          onChange={(e) =>
            onChange({ ...options, stretch: e.target.value as Options['stretch'] })
          }
          data-testid="fits-stretch"
        >
          {STRETCHES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Black and white points
        <select
          value={options.clip}
          onChange={(e) => onChange({ ...options, clip: e.target.value as Options['clip'] })}
          data-testid="fits-clip"
        >
          {CLIPS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Preview size
        <select
          value={options.size}
          onChange={(e) => onChange({ ...options, size: Number(e.target.value) })}
          data-testid="fits-size"
        >
          {SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function plan(files: File[], options: Options): PlanResult {
  if (files.length === 0) {
    return { kind: 'error', message: 'Drop one or more FITS images.' };
  }
  if (files.length > MAX_IMAGES) {
    return {
      kind: 'error',
      message: `That is ${files.length} images; this form submits at most ${MAX_IMAGES} at a time.`,
    };
  }
  if (options.mode === 'composite' && files.length !== 3) {
    return {
      kind: 'error',
      message: `A colour composite needs exactly three images, for red, green and blue. You dropped ${files.length}.`,
    };
  }

  const unsafe = files.filter((f) => !isSafeFileName(f.name));
  if (unsafe.length) {
    return {
      kind: 'error',
      message: `Rename ${unsafe.map((f) => `“${f.name}”`).join(', ')}: letters, digits, dot, dash and underscore only.`,
    };
  }
  const notFits = files.filter((f) => !looksLikeFits(f.name));
  if (notFits.length) {
    return {
      kind: 'error',
      message: `${notFits.map((f) => `“${f.name}”`).join(', ')} ${notFits.length === 1 ? 'is not' : 'are not'} a FITS file. Expected .fits or .fit.`,
    };
  }
  const tooBig = files.find((f) => f.size > MAX_FILE_BYTES);
  if (tooBig) {
    return {
      kind: 'error',
      message: `“${tooBig.name}” is ${formatBytes(tooBig.size)}, over the ${formatBytes(MAX_FILE_BYTES)} this form accepts.`,
    };
  }

  const names = files.map((f) => f.name);
  // In composite mode the three frames become red, green and blue in
  // the order they were dropped. The runner is told which is which;
  // guessing from the file name would be wrong for anyone whose
  // filters are not called r, g and b.
  const images = files.map((f, i) => ({
    file: f.name,
    label: f.name,
    ...(options.mode === 'composite' ? { channel: CHANNELS[i] } : {}),
  }));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const title = options.mode === 'composite' ? `colour: ${names.join(' + ')}` : names.join(', ');

  return {
    kind: 'job',
    batchName: batchNameFor(options.mode),
    submitFile: buildSubmitFile({
      inputNames: names,
      inputBytes: bytes,
      batchName: batchNameFor(options.mode),
      title,
    }),
    uploads: [
      // The generated Python runner, then the images under their own
      // names -- the runner reads them by those names.
      {
        name: RUNNER_FILE,
        file: new File([buildRunner(runnerConfig(options, images))], RUNNER_FILE, {
          type: 'text/x-python',
        }),
      },
      ...files.map((f) => ({ name: f.name, file: f })),
    ],
  };
}

function Results({ job }: ResultsProps) {
  return <FitsResults job={job} />;
}

export const astro: Pipeline<Options> = {
  id: 'fitsprev',
  name: 'FITS previews',
  summary: 'Statistics and a viewable preview for astronomical images, or a colour composite.',
  accept: '.fits,.fit,.FITS,.FIT',
  multiple: true,
  inputLabel: 'FITS images',
  defaults: DEFAULT_OPTIONS,
  Controls,
  plan,
  Results,
};
