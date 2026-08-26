import { z } from 'zod';
import { TournamentState } from './enums.js';

/**
 * `GET`/`POST /api/tournaments/:id/lifecycle` — DESIGN.md, "Everything
 * else": "the lifecycle state machine rendered: current state, the
 * transitions currently legal, and each one's guard shown as a checklist."
 *
 * `START` is deliberately absent from `LifecycleAction` — starting a
 * tournament additionally runs a live Discord permission preflight,
 * fetches every checked-in member for a display-name snapshot, and
 * provisions round-1 threads (`discord/commands/tournament.ts`'s
 * `handleStart`), none of which the REST layer has a path to without
 * pulling a live `discord.js` `Guild` into this boundary — the one thing
 * `Ports and Adapters` exists to keep out. `startGuards` still reports
 * what it *can* check straight from Postgres (config bound, checked-in
 * count, pack size) so the console isn't silent about it — it just can't
 * fire the transition itself yet. Run `/tournament start` in Discord.
 */
export const LifecycleAction = z.enum(['OPEN_REGISTRATION', 'CLOSE_REGISTRATION', 'OPEN_CHECKIN', 'CLOSE_CHECKIN', 'CANCEL', 'RENAME']);
export type LifecycleAction = z.infer<typeof LifecycleAction>;

export const LifecycleRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('OPEN_REGISTRATION') }),
  z.object({ action: z.literal('CLOSE_REGISTRATION') }),
  z.object({ action: z.literal('OPEN_CHECKIN') }),
  z.object({ action: z.literal('CLOSE_CHECKIN') }),
  z.object({ action: z.literal('CANCEL') }),
  z.object({ action: z.literal('RENAME'), name: z.string().min(1) }),
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
});
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;
