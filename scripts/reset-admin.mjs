#!/usr/bin/env node
/**
 * Recovery for a lost administrator password.
 *
 *   DATABASE_URL="postgres://..." npm run reset-admin
 *
 * Deletes every user (their sessions go with them) so the dashboard shows the first-run setup screen again.
 * Run history and the audit log are NOT touched. You will need SETUP_TOKEN to create the new administrator.
 */
import pg from 'pg';
import { createInterface } from 'node:readline/promises';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to the same Postgres connection string the server uses.'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('This deletes ALL user accounts so you can create a new administrator. Type RESET to continue: ');
rl.close();
if (answer.trim() !== 'RESET') { console.log('Cancelled. Nothing changed.'); process.exit(0); }

const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
try {
  const { rowCount } = await pool.query('DELETE FROM users');
  console.log(`Removed ${rowCount} account(s). Open the dashboard: it will show the setup screen.`);
} finally {
  await pool.end();
}
