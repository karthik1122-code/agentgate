// Shared by the Vercel functions in api/play/. The leading underscore keeps Vercel from exposing this file as a route.
import { readFileSync } from 'node:fs';
import { createPlayground } from '../src/play.mjs';
import { createPlayHttp } from '../src/play-http.mjs';

const policy = JSON.parse(readFileSync(new URL('../policies/default.json', import.meta.url), 'utf8'));
const handle = createPlayHttp(createPlayground(policy));
export const route = name => (req, res) => handle(req, res, name);
