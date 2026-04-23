import type { ClientSession } from './server.js';

/**
 * Per-request ambient context.
 *
 * Node.js is single-threaded and all TL handlers are synchronous with respect
 * to a single encrypted message, so a module-level "current session" is safe
 * **within a request** — but only if it is strictly reset when the top-level
 * handler returns. Otherwise later code (background timers, updates that are
 * constructed after the handler has returned, etc.) can read a stale session
 * and attribute data to the wrong user.
 *
 * The recommended way to propagate the session is as an explicit function
 * parameter. This context exists only for a couple of legacy call sites that
 * need the session's `.layer` to pick between wire-format dialects in deeply
 * nested writers, where threading the parameter through would be noisy.
 *
 * Rules:
 *   1. Only `handleTlRequest` in handlers.ts is allowed to call
 *      `setCurrentSession` (via the save/restore wrapper).
 *   2. Callers that need the current user id MUST use
 *      `requireAuth(session)` on the explicit parameter, not `currentSession()`.
 *   3. If you find yourself reaching for `currentSession()` for anything other
 *      than layer/dialect detection, you are holding it wrong — thread the
 *      session through instead.
 */
let _current: ClientSession | undefined;

export function setCurrentSession(session: ClientSession | undefined): void {
  _current = session;
}

export function currentSession(): ClientSession | undefined {
  return _current;
}
