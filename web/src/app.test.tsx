import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './app';
import { Results } from './components/Results';

// A render smoke test, with fetch stubbed.
//
// It is here because `make e2e` cannot run (see README) and without it
// nothing at all exercises app.tsx: a component that throws on its
// first render would pass lint, typecheck, build and every other test
// in this repository.

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

function textOnce(body: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  } as unknown as Response);
}

function jsonOnce(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (input: string) => {
    if (input.includes('/auth/me')) return jsonOnce({ authenticated: true, username: 'rwilson' });
    if (input.includes('/jobs')) return jsonOnce({ jobs: [] });
    return jsonOnce({});
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the page', () => {
  it('renders without an API and without an error notice', async () => {
    await act(async () => {
      root.render(<App />);
    });
    expect(container.querySelector('h1')?.textContent).toBeTruthy();
    expect(container.querySelector('[data-testid="error"]')).toBeNull();
  });

  it('refuses to submit until a file is added, and says so', async () => {
    await act(async () => {
      root.render(<App />);
    });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Add a file');
  });

  it('offers the four counting options and nothing about batch systems', async () => {
    await act(async () => {
      root.render(<App />);
    });
    for (const id of ['skip-common', 'fold-case', 'min-length', 'top-n']) {
      expect(container.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    // No CPU or memory knob: counting words in a text file has a right
    // answer for both, so AGENTS.md says set it in code and do not ask.
    expect(container.textContent).not.toMatch(/CPU|cores|Memory \(MB\)|submit file|ClassAd/i);
  });

  it('says the queue is empty rather than showing nothing', async () => {
    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toContain('Nothing counted yet');
  });
});

const RESULTS = JSON.stringify({
  file: 'moby.txt',
  totalWords: 10,
  countedWords: 6,
  uniqueWords: 2,
  options: { minLength: 3, topN: 25, foldCase: true, skipCommonWords: true },
  words: [
    { word: 'whale', count: 4, share: 66.67 },
    { word: 'ship', count: 2, share: 33.33 },
  ],
});

describe('the results view', () => {
  function serve(results: string) {
    vi.stubGlobal('fetch', (input: string) => {
      if (input.includes('/stdout')) return textOnce('Word frequencies for moby.txt\n');
      if (input.includes('/files/')) return textOnce(results);
      return jsonOnce({});
    });
  }

  it('draws a table from the JSON, not a block of text', async () => {
    serve(RESULTS);
    await act(async () => {
      root.render(<Results jobId="1.0" />);
    });
    const table = container.querySelector('[data-testid="results-table"]');
    expect(table).not.toBeNull();
    const words = [...container.querySelectorAll('td.word')].map((td) => td.textContent);
    expect(words).toEqual(['whale', 'ship']);
    // The <pre> is the fallback, not the default view.
    expect(container.querySelector('[data-testid="results"]')).toBeNull();
  });

  it('re-sorts when a column header is clicked', async () => {
    serve(RESULTS);
    await act(async () => {
      root.render(<Results jobId="1.0" />);
    });
    const byWord = [...container.querySelectorAll('button.sort')].find((b) =>
      b.textContent?.startsWith('Word'),
    )!;
    await act(async () => {
      byWord.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect([...container.querySelectorAll('td.word')].map((td) => td.textContent)).toEqual([
      'ship',
      'whale',
    ]);
  });

  it('falls back to the summary when the job wrote no counts', async () => {
    // results.json exists but is empty: the job was created with the
    // file in place and then failed. The summary is where the real
    // error is, so it must be shown outright.
    serve('');
    await act(async () => {
      root.render(<Results jobId="1.0" />);
    });
    expect(container.querySelector('[data-testid="results-table"]')).toBeNull();
    expect(container.querySelector('[data-testid="results"]')?.textContent).toContain(
      'Word frequencies',
    );
  });
});
