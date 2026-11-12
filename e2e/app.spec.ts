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
