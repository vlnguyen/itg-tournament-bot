import { z } from 'zod';
import { TournamentState } from './enums.js';
import { FormatKey } from './formats.js';

/**
 * `GET`/`POST /api/tournaments/:id/lifecycle` — DESIGN.md, "Everything
 * else": "the lifecycle state machine rendered: current state, the
 * transitions currently legal, and each one's guard shown as a checklist."
 *
 * `START` runs the same `startTournamentWithDiscordEffects` `/tournament
 * start` does — the permission preflight, the display-name snapshot, and
 * round-1 thread provisioning all happen server-side against the bot's own
 * injected Discord client, not against anything the browser can see. A
 * start blocked by that preflight comes back as a 400 naming what's
 * missing, the same wording the Discord command itself would show.
 */
export const LifecycleAction = z.enum(['OPEN_REGISTRATION', 'CLOSE_REGISTRATION', 'OPEN_CHECKIN', 'CLOSE_CHECKIN', 'START', 'CANCEL', 'RENAME']);
export type LifecycleAction = z.infer<typeof LifecycleAction>;

export const LifecycleRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('OPEN_REGISTRATION') }),
  z.object({ action: z.literal('CLOSE_REGISTRATION') }),
  z.object({ action: z.literal('OPEN_CHECKIN') }),
  z.object({ action: z.literal('CLOSE_CHECKIN') }),
  z.object({ action: z.literal('START') }),
  z.object({ action: z.literal('CANCEL') }),
  z.object({ action: z.literal('RENAME'), name: z.string().min(1) }),
  // Deliberately not a `LifecycleAction` — that enum feeds `legalActions`,
  // which the web page renders as a row of one-click buttons. A format
  // change takes an argument (which format), so a button with no way to
  // choose one would be the wrong control; the web format picker calls this
  // action directly instead of reading it out of `legalActions`.
  z.object({ action: z.literal('SET_FORMAT'), formatKey: FormatKey }),
]);
export type LifecycleRequest = z.infer<typeof LifecycleRequest>;

export const GuardCheck = z.object({ label: z.string(), ok: z.boolean() });
export type GuardCheck = z.infer<typeof GuardCheck>;

export const LifecycleStatus = z.object({
  state: TournamentState,
  name: z.string(),
  legalActions: z.array(LifecycleAction),
  /** Informational even outside `CHECKIN_CLOSED` — a TO can see what's still missing before it's even relevant. */
  startGuards: z.array(GuardCheck),
  /** The tournament's current default, stamped onto every match at generation. */
  defaultFormatKey: FormatKey,
  /** False once the bracket is materialized (`RUNNING` onward) — changing it after that point would not affect any already-generated match. */
  formatEditable: z.boolean(),
});
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;
