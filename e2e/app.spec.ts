import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, passwordFor, type DemoCredentials } from './fixtures/login';

const creds: DemoCredentials = JSON.parse(
  readFileSync(process.env.DEMO_CREDENTIALS_FILE!, 'utf8'),
);
const APP_ID = process.env.APP_ID ?? 'wordfreq-app';
const APP_URL = `/site/${APP_ID}/`;

const SAMPLE = [
  'the quick brown fox jumps over the lazy dog',
  'the quick brown fox returns and the dog sleeps',
].join('\n');

async function dropText(page: import('@playwright/test').Page, name: string, body = SAMPLE) {
  await page.getByTestId('file-input').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(body + '\n'),
  });
}

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

test('nothing can be submitted until a file is added', async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page.getByTestId('submit')).toBeDisabled();
  await dropText(page, 'fox.txt');
  await expect(page.getByTestId('submit')).toBeEnabled();
});

test('one job per dropped file reaches the real queue', async ({ page }) => {
  await page.goto(APP_URL);

  // Attach files through the hidden input; drag-and-drop is the same
  // code path below it.
  await dropText(page, 'fox-one.txt');
  await dropText(page, 'fox-two.txt');
  await expect(page.getByTestId('file-list')).toContainText('fox-one.txt');
  await expect(page.getByTestId('file-list')).toContainText('fox-two.txt');

  await page.getByTestId('submit').click();

  await expect(page.getByTestId('submitted')).toContainText('Sent 2 files');

  // The names come back from the QUEUE, through the projection in
  // api.ts, not from React state -- which is what proves both jobs
  // exist and that +WordFreqFile survived the round trip. Asserting on
  // local state would pass even if nothing had been submitted.
  const list = page.getByTestId('job-list');
  await expect(list).toContainText('fox-one.txt');
  await expect(list).toContainText('fox-two.txt');
});

test('a submitted job reports a state in words, never a bare number', async ({ page }) => {
  await page.goto(APP_URL);
  await dropText(page, 'fox.txt');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('submitted')).toBeVisible();

  // Any of the real states is fine; "Unknown" is not, and neither is a
  // digit on its own. This is the assertion that catches the missing
  // projection: without it a finished job reads "Failed (exit
  // undefined)".
  const status = page.getByTestId('job-status').first();
  await expect(status).toBeVisible();
  await expect(status).not.toHaveText('Unknown');
  await expect(status).not.toHaveText(/undefined/);
  await expect(status).not.toHaveText(/^\d+$/);
});

test('the counted result comes back as a table, not a tar', async ({ page }) => {
  test.slow(); // the job has to be matched, run and transferred back

  await page.goto(APP_URL);
  await dropText(page, 'fox.txt');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('submitted')).toBeVisible();

  // Poll the real queue until the job finishes; the page refreshes
  // itself every five seconds.
  const show = page.getByRole('button', { name: 'Show results' }).first();
  await expect(show).toBeVisible({ timeout: 180_000 });
  await show.click();

  // A real table drawn from results.json. This is the assertion that
  // proves the job wrote valid JSON and the page parsed it -- a <pre>
  // of the summary would pass a looser "contains the word" check.
  const table = page.getByTestId('results-table');
  await expect(table).toBeVisible();

  // "quick" appears twice and is not a stopword; "the" is one and is
  // dropped by default, which checks the options reached the job.
  await expect(table.locator('td.word')).toContainText(['quick']);
  await expect(table.locator('td.word').filter({ hasText: /^the$/ })).toHaveCount(0);

  // Sorting is the thing a table buys over text: clicking Word must
  // reorder the rows.
  const before = await table.locator('td.word').allTextContents();
  await table.getByRole('button', { name: /^Word/ }).click();
  const after = await table.locator('td.word').allTextContents();
  expect(after).toEqual([...before].sort());

  // The prose summary is still reachable, because it is what people
  // paste into an email.
  await page.getByRole('button', { name: 'Show the plain summary' }).click();
  await expect(page.getByTestId('results')).toContainText('Word frequencies for fox.txt');
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
  await dropText(page, 'fox.txt');
  await page.getByTestId('submit').click();

  // The server's own message, not a generic "something went wrong":
  // the API writes these to be read by the person who hit them.
  await expect(page.getByTestId('error')).toContainText('the schedd is not answering');
});
