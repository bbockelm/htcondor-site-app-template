import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, passwordFor, type DemoCredentials } from './fixtures/login';

const creds: DemoCredentials = JSON.parse(
  readFileSync(process.env.DEMO_CREDENTIALS_FILE!, 'utf8'),
);
const APP_ID = process.env.APP_ID ?? 'blast-app';
const APP_URL = `/site/${APP_ID}/`;

const DATABASE = {
  name: 'reference.fasta',
  mimeType: 'text/plain',
  buffer: Buffer.from('>ref1\nACGTACGTACGTACGTACGTACGT\n>ref2\nTTTTGGGGCCCCAAAA\n'),
};

function query(n: number) {
  return {
    name: `query${n}.fasta`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`>q${n}\nACGTACGTACGT\n`),
  };
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

test('the cost of the submission is stated before the button is enabled', async ({ page }) => {
  await page.goto(APP_URL);

  // Nothing chosen yet: the button must not be usable and the page must
  // say what is missing rather than nothing at all.
  await expect(page.getByTestId('submit')).toBeDisabled();
  await expect(page.getByTestId('plan')).toContainText('reference database');

  await page.getByTestId('database-input').setInputFiles(DATABASE);
  await page.getByTestId('query-input').setInputFiles([query(1), query(2), query(3)]);

  // The database is uploaded once per job -- the one number that
  // decides whether a submission is reasonable. If this sentence ever
  // stops appearing, the app has started hiding its own cost.
  const plan = page.getByTestId('plan');
  await expect(plan).toContainText('3 files in 3 jobs');
  await expect(plan).toContainText('sent once per job');
  await expect(page.getByTestId('submit')).toBeEnabled();
});

test('a file the submit file could not carry is refused by name', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId('database-input').setInputFiles(DATABASE);
  await page.getByTestId('query-input').setInputFiles({
    name: 'my sequences,v2.fasta',
    mimeType: 'text/plain',
    buffer: Buffer.from('>q\nACGT\n'),
  });

  // A comma would end the transfer_input_files entry and a space would
  // split the shell word. The app says which file and what to do,
  // rather than silently dropping it.
  await expect(page.getByTestId('plan')).toContainText('Rename');
  await expect(page.getByTestId('submit')).toBeDisabled();
});

test('submitting reaches the real queue, one job per group of queries', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId('database-input').setInputFiles(DATABASE);
  await page.getByTestId('query-input').setInputFiles([query(1), query(2)]);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('submitted')).toContainText('2 jobs are on their way');

  // Real cluster.proc ids from the schedd, not a button that changed
  // state. And "Receiving its files", never "Stopped": every job this
  // app submits is HELD with HoldReasonCode 16 between POST /jobs and
  // the input upload, and calling that stopped would be a lie.
  const list = page.getByTestId('search-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText(/Job \d+\.\d+/);
  await expect(list).not.toContainText('Stopped:');
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
  await page.getByTestId('database-input').setInputFiles(DATABASE);
  await page.getByTestId('query-input').setInputFiles([query(1)]);
  await page.getByTestId('submit').click();

  // The server's own message, not a generic "something went wrong":
  // the API writes these to be read by the person who hit them.
  await expect(page.getByTestId('error')).toContainText('the schedd is not answering');
});
