import { AuthError } from '../auth.mjs';
import { GateError } from '../runtime.mjs';
import { send } from './respond.mjs';

// Domain errors carry a code; this maps each code to an HTTP status in one place.
const AUTH_STATUS = { bad_credentials: 401, locked: 429, already_set_up: 409, email_taken: 409, not_found: 404, self_delete: 409, last_admin: 409, needs_setup: 409, signup_limited: 429, self_role: 409 };
const GATE_STATUS = { busy: 409, run_closed: 409, not_external: 409, not_found: 404, not_pending: 409, already_decided: 409, expired: 410, hash_mismatch: 409, same_actor: 403, invalid_decision: 400, invalid_approver: 400, unknown_planner: 400, invalid_actor: 400 };

/** Sends the right reply for a known error and returns true; returns false for anything unexpected. */
export function sendKnownError(res, error) {
  if (error instanceof AuthError) return send(res, AUTH_STATUS[error.code] || 400, { error: error.code, message: error.message });
  if (error instanceof GateError) return send(res, GATE_STATUS[error.code] || 400, { error: error.code, message: error.message });
  if (error.status) return send(res, error.status, { error: error.message }); // body too large or not JSON
  return false;
}
