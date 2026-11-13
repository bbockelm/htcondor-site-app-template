import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, passwordFor, type DemoCredentials } from './fixtures/login';

const creds: DemoCredentials = JSON.parse(
  readFileSync(process.env.DEMO_CREDENTIALS_FILE!, 'utf8'),
);
const APP_ID = process.env.APP_ID ?? 'htcondor-site-app-template';
const APP_URL = `/site/${APP_ID}/`;

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin', passwordFor(creds, 'admin'));
});

test('the app is served under its own id and knows where it is', async ({ page }) => {
  await page.goto(APP_URL);

  // Not just "something rendered": assert the server injected the
  // mount point. Without it every relative asset still resolves (the
  // browser falls back to the directory) but client-side routing
  // silently builds wrong URLs.
  const injected = await page.evaluate(() => window.__HTCONDOR_APP__);
  expect(injected?.id).toBe(APP_ID);
  expect(injected?.base).toBe(APP_URL);

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('what to run is asked before which files to run it on', async ({ page }) => {
  await page.goto(APP_URL);

  // A slot's label, its hint and its `accept` all belong to the
  // pipeline, so a form that takes the files first is labelling its
  // pickers for whatever pipeline happened to be selected by default.
  // Asserted on DOM order rather than on coordinates: that is what the
  // reading order actually is, and it does not depend on the window.
  const before = await page.evaluate(() => {
    const pipeline = document.querySelector('[data-testid="pipeline"]');
    const picker = document.querySelector('[data-testid="file-input"]');
    if (!pipeline || !picker) return null;
    // DOCUMENT_POSITION_FOLLOWING: the picker comes after the pipeline.
    return Boolean(pipeline.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);

  // And the pipeline explains itself where it is chosen, rather than
  // leaving a first-time user to guess from the slot labels.
  await expect(page.getByTestId('pipeline-summary')).not.toBeEmpty();
  await expect(page.getByTestId('pipeline-about')).toContainText('What you need');
});

test('submitting reaches the real queue', async ({ page }) => {
  await page.goto(APP_URL);

  // Attach a file through the hidden input; drag-and-drop is the same
  // code path below it.
  await page.getByTestId('file-input').setInputFiles({
    name: 'sample.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the e2e suite\n'),
  });
  await expect(page.getByTestId('file-list')).toContainText('sample.txt');

  await page.getByTestId('submit').click();

  // The success notice carries the real cluster.proc the schedd
  // assigned, so asserting on it proves the submit reached the queue
  // rather than that a button changed state.
  const notice = page.getByTestId('submitted');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/Submitted job \d+\.\d+/);

  await expect(page.getByTestId('job-list')).toBeVisible();
});

test('an API failure is reported in words, not swallowed', async ({ page }) => {
  await page.route('**/api/v1/jobs', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'the schedd is not answering' }),
        })
      : route.continue(),
  );

  await page.goto(APP_URL);

  // A file first. Every pipeline refuses to plan an empty submission,
  // and that refusal is a client-side message that never reaches the
  // API -- so without this the route below is never hit and the test
  // passes or fails on the wrong error entirely.
  await page.getByTestId('file-input').setInputFiles({
    name: 'sample.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the e2e suite\n'),
  });
  await expect(page.getByTestId('file-list')).toContainText('sample.txt');

  await page.getByTestId('submit').click();

  // The server's own message, not a generic "something went wrong":
  // the API writes these to be read by the person who hit them.
  await expect(page.getByTestId('error')).toContainText('the schedd is not answering');
});

test('the example data is enough to submit with, on its own', async ({ page }) => {
  await page.goto(APP_URL);

  // The whole reason the box exists: a person seeing this for the
  // first time has no text file, no FITS frames and no BLAST database,
  // and without it there is nothing they can do but read the form.
  await page.getByTestId('use-example').check();
  await expect(page.getByTestId('example-files')).toContainText('.txt');

  await page.getByTestId('submit').click();

  const notice = page.getByTestId('submitted');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/Submitted job \d+\.\d+/);
});

test('a finished job shows what it found, not only a download link', async ({ page }) => {
  // This one waits for a real job to run in the demo pool, so it is
  // slower than the rest. It is also the only test that proves the
  // results view is reachable at all: every pipeline shipped one for a
  // while, and the shell rendered none of them.
  test.setTimeout(240_000);

  await page.goto(APP_URL);
  await page.getByTestId('use-example').check();
  await page.getByTestId('submit').click();

  const submitted = page.getByTestId('submitted');
  await expect(submitted).toBeVisible();
  const id = (await submitted.innerText()).match(/(\d+\.\d+)/)![1];

  // The list polls every five seconds; a word count of four kilobytes
  // is seconds of compute and the rest is scheduling and transfer.
  const toggle = page.getByTestId(`results-toggle-${id}`);
  await expect(toggle).toBeVisible({ timeout: 200_000 });
  await toggle.click();

  const results = page.getByTestId(`results-${id}`);
  await expect(results).toBeVisible();
  // The counts, read from the job's results.json -- not the stdout
  // text, and not a link to a tarball.
  await expect(results.getByTestId('results-table')).toBeVisible();
  // A content word out of the passage, not a common one: "Skip common
  // words" is on by default, so "the" is deliberately NOT in the table
  // and asserting on it tests the wrong thing entirely.
  await expect(results.getByTestId('results-table')).toContainText('species');
  await expect(results.getByTestId('results-summary')).toContainText(/\d+ words in the file/);

  // ON A PHONE the same table is a list of cards.
  //
  // Checked against the real rendered page at a real phone width,
  // because this is CSS and nothing else can tell you whether it
  // happened. The layout is a media query, not a measurement, so the
  // same resize the browser does is the whole mechanism -- there is no
  // JavaScript to re-run and no first paint to get wrong.
  await page.setViewportSize({ width: 390, height: 844 });
  const table = results.getByTestId('results-table');

  // Rows and cells are no longer laid out as a table.
  const layout = await table.evaluate((el) => ({
    row: getComputedStyle(el.querySelector('tbody tr')!).display,
    cell: getComputedStyle(el.querySelector('tbody td')!).display,
    heading: getComputedStyle(el.querySelector('thead th.rank')!).display,
  }));
  expect(layout.row).toBe('block');
  expect(layout.cell).toBe('flex');
  // A heading that is not a sort control has nothing to do here: its
  // text now travels with each cell instead.
  expect(layout.heading).toBe('none');

  // The column's meaning travels with the value: the heading is drawn
  // in front of each cell from data-label, so a card is not a column
  // of unlabelled numbers.
  const labelled = await table.locator('tbody tr').first().evaluate((row) => {
    const cells = [...row.querySelectorAll('td')];
    return cells.map((td) => ({
      label: td.getAttribute('data-label'),
      before: getComputedStyle(td, '::before').content,
    }));
  });
  expect(labelled.map((c) => c.label)).toEqual(['Rank', 'Word', 'Times used', 'Share']);
  expect(labelled.map((c) => c.before)).toEqual([
    '"Rank"',
    '"Word"',
    '"Times used"',
    '"Share"',
  ]);

  // Sorting is not lost with the headings: the two heading buttons
  // stay, as a sort bar above the cards.
  await expect(table.getByRole('button', { name: /Times used/ })).toBeVisible();
  await expect(table.getByRole('button', { name: /^Word/ })).toBeVisible();

  // And nothing runs off the side of the screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a workflow’s results are gathered from every node', async ({ page }) => {
  // BLAST is a DAG, so the job in the list is the MANAGER: it has no
  // hits of its own and its results are whatever its nodes wrote into
  // the shared sandbox. That path has its own ways to fail silently --
  // nodes overwriting each other's output, a manifest that cannot be
  // read back -- none of which a unit test can see.
  //
  // The demo pool has no BLAST+ installed, so the search fails. That
  // is deliberately not avoided here: the runner writes its results
  // file on EVERY path, so a failed search must still arrive as an
  // explanation rather than as a blank panel, and this is the only
  // test that checks it does.
  test.setTimeout(300_000);

  await page.goto(APP_URL);
  await page.getByTestId('pipeline').selectOption('blast');
  await page.getByTestId('use-example').check();
  await expect(page.getByTestId('example-files-database')).toContainText('.fasta');
  await expect(page.getByTestId('example-files-queries')).toContainText('.fasta');

  await page.getByTestId('submit').click();
  const submitted = page.getByTestId('submitted');
  await expect(submitted).toBeVisible({ timeout: 60_000 });
  const id = (await submitted.innerText()).match(/(\d+\.\d+)/)![1];

  const toggle = page.getByTestId(`results-toggle-${id}`);
  await expect(toggle).toBeVisible({ timeout: 260_000 });
  await toggle.click();

  const results = page.getByTestId(`results-${id}`);
  await expect(results.getByTestId('blast-results')).toBeVisible();
  // One search, found and read: proof the node's output was located in
  // the workflow's sandbox under the name the node gave it.
  await expect(results.getByTestId('blast-results')).toContainText('across 1 search');
  // ...and the node's own words about why it found nothing, which is
  // the whole point of writing a results file on the failure path.
  await expect(results.getByTestId('blast-node-problem')).toContainText('blastn');
});
