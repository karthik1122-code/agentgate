// Browser journey against the real server (memory store). Run with: npm run test:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server, browser;

test.before(async () => {
  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', AUTH: 'on', SETUP_TOKEN: 'e2e-setup' }, stdio: ['ignore', 'pipe', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.kill(); });

test('set up an admin, run an agent, approve the held refund, and the run log verifies', async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/app`);
  await page.getByRole('button', { name: /create administrator/i }).click();
  await page.getByText('Enter your name.').waitFor(); // checked before anything is sent

  await page.getByLabel('Your name').fill('Ada');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel(/password/i).fill('a-long-password');
  await page.getByLabel('Setup token').fill('e2e-setup');
  await page.getByRole('button', { name: /create administrator/i }).click();

  await page.getByRole('button', { name: /run a demo agent/i }).first().click();
  await page.getByText('Review them now').waitFor();
  await page.locator('#nav').getByText('Approvals').click();
  await page.getByRole('button', { name: /^approve/i }).first().click();
  await page.getByText('ALL CLEAR').waitFor();

  const runs = await page.evaluate(async () => (await fetch('/api/runs')).json());
  const view = await page.evaluate(async id => (await fetch(`/api/runs/${id}`)).json(), runs[0].id);
  assert.equal(view.integrity.valid, true);
  assert.ok(view.events.some(e => e.type === 'approval_granted' && /ada@example\.com/.test(JSON.stringify(e.data))));
  assert.deepEqual(errors, []);
  await page.close();
});

test('phones: no sideways scrolling, and Sign out is on screen', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
  await page.goto(`${BASE}/app`);
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('a-long-password');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const out = page.getByRole('button', { name: /sign out/i });
  await out.waitFor();
  const box = await out.boundingBox();
  assert.ok(box.x + box.width <= 390, 'Sign out is inside the screen');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
  await page.close();
});
