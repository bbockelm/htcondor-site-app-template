import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, passwordFor, type DemoCredentials } from './fixtures/login';

const creds: DemoCredentials = JSON.parse(readFileSync(process.env.DEMO_CREDENTIALS_FILE!, 'utf8'));
const APP_ID = process.env.APP_ID ?? 'htcondor-site-app-template';
const APP_URL = `/site/${APP_ID}/`;

/**
 * A FITS file, built in the test.
 *
 * Small and real: a 2880-byte header block declaring a 20x20 float32
 * image, then the data padded to a 2880-byte boundary. The demo pool's
 * execute node almost certainly has no astropy, so the job will report
 * that in words -- which is itself the thing worth asserting, because
 * "it degrades sensibly when astropy is missing" is a claim this suite
 * can actually check.
 */
function fitsFile(): Buffer {
  const cards = [
    'SIMPLE  =                    T',
    'BITPIX  =                  -32',
    'NAXIS   =                    2',
    'NAXIS1  =                   20',
    'NAXIS2  =                   20',
    "OBJECT  = 'E2E TARGET'",
    'END',
  ];
  const header = Buffer.alloc(2880, 0x20);
  cards.forEach((c, i) => header.write(c.padEnd(80, ' '), i * 80, 'ascii'));
  const pixels = Buffer.alloc(20 * 20 * 4);
  for (let i = 0; i < 400; i++) pixels.writeFloatBE(i % 97, i * 4);
  const data = Buffer.alloc(2880);
  pixels.copy(data);
  return Buffer.concat([header, data]);
}

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin', passwordFor(creds, 'admin'));
});

test('the app is served under its own id and knows where it is', async ({ page }) => {
  await page.goto(APP_URL);

  const injected = await page.evaluate(() => window.__HTCONDOR_APP__);
  expect(injected?.id).toBe(APP_ID);
  expect(injected?.base).toBe(APP_URL);

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the cost of a submission is stated before the button can be pressed', async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page.getByTestId('submit')).toBeDisabled();

  await page.getByTestId('file-input').setInputFiles([
    { name: 'a.fits', mimeType: 'application/fits', buffer: fitsFile() },
    { name: 'b.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);

  // Two images, two jobs, and the number of bytes this will push.
  await expect(page.getByTestId('plan')).toContainText('2 jobs');
  await expect(page.getByTestId('plan')).toContainText('uploaded from this computer');
  await expect(page.getByTestId('submit')).toBeEnabled();
});

test('a file that cannot be transferred is named, not silently dropped', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId('file-input').setInputFiles([
    { name: 'my frame.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);
  await expect(page.getByTestId('blocker')).toContainText('my frame.fits');
  await expect(page.getByTestId('submit')).toBeDisabled();
});

test('a colour composite needs more than one filter', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId('mode').selectOption('composite');
  await page.getByTestId('file-input').setInputFiles([
    { name: 'r.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);
  await expect(page.getByTestId('blocker')).toContainText('at least two filters');

  await page.getByTestId('file-input').setInputFiles([
    { name: 'b.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);
  // One job, not two: the frames have to be in the same job to be
  // combined.
  await expect(page.getByTestId('plan')).toContainText('One job');
  await expect(page.getByTestId('submit')).toBeEnabled();
});

test('submitting reaches the real queue, and the job reports itself in words', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(APP_URL);

  await page.getByTestId('file-input').setInputFiles([
    { name: 'e2e.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('submitted')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('job-list')).toContainText('e2e.fits');

  // The job is held under HoldReasonCode 16 between submit and the
  // input upload. Whatever it says there, it must not say the job
  // stopped or failed -- that is the first thing a user ever sees.
  await expect(page.getByTestId('job-list')).not.toContainText(/stopped|failed/i);

  // And once it finishes, the results panel says what happened. On a
  // demo pool with no astropy that is the "ask your administrator"
  // sentence, which is exactly the degradation this app promises.
  const showResults = page.getByRole('button', { name: 'Show results' });
  await expect(showResults).toBeVisible({ timeout: 150_000 });
  await showResults.click();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('results')).toContainText(/astropy|numpy|FITS/i);
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
  await page.getByTestId('file-input').setInputFiles([
    { name: 'e2e.fits', mimeType: 'application/fits', buffer: fitsFile() },
  ]);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('error')).toContainText('the schedd is not answering');
});
