import { z } from 'zod';
import { BracketSide, TournamentState } from './enums.js';
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
export const LifecycleAction = z.enum([
  'OPEN_REGISTRATION',
  'CLOSE_REGISTRATION',
  'OPEN_CHECKIN',
  'CLOSE_CHECKIN',
  'START',
  'GENERATE_BRACKET',
  'CANCEL',
  'RENAME',
]);
export type LifecycleAction = z.infer<typeof LifecycleAction>;

/** The three ways a TO can resolve `setTournamentFormat` finding matches on more than one format. See that function's own comment. "Cancel" is not a mode — the caller simply doesn't send the request. */
export const SetTournamentFormatMode = z.enum(['UPDATE_ALL', 'DEFAULT_ONLY']);
export type SetTournamentFormatMode = z.infer<typeof SetTournamentFormatMode>;

export const LifecycleRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('OPEN_REGISTRATION') }),
  z.object({ action: z.literal('CLOSE_REGISTRATION') }),
  z.object({ action: z.literal('OPEN_CHECKIN') }),
  z.object({ action: z.literal('CLOSE_CHECKIN') }),
  z.object({ action: z.literal('START') }),
  // Generates (or regenerates) the bracket ahead of Start — see DESIGN.md,
  // "Match Format as a Plugin". Legal only at CHECKIN_CLOSED, same as START.
  z.object({ action: z.literal('GENERATE_BRACKET') }),
  z.object({ action: z.literal('CANCEL') }),
  z.object({ action: z.literal('RENAME'), name: z.string().min(1) }),
  // Deliberately not a `LifecycleAction` — that enum feeds `legalActions`,
  // which the web page renders as a row of one-click buttons. A format
  // change takes an argument (which format), so a button with no way to
  // choose one would be the wrong control; the web format picker calls this
  // action directly instead of reading it out of `legalActions`.
  z.object({ action: z.literal('SET_FORMAT'), formatKey: FormatKey, mode: SetTournamentFormatMode.optional() }),
]);
export type LifecycleRequest = z.infer<typeof LifecycleRequest>;

/**
 * `POST /api/tournaments/:id/match-formats` — assigns one format to one or
 * more matches (a single match, a whole round, or an arbitrary
 * multi-selection; `setMatchFormats` doesn't distinguish). `MatchRef`
 * itself has no wire schema in `@itg/shared`'s `bracket.ts` (that file is
 * pure domain logic, no zod), so its shape is validated here instead,
 * alongside the rest of this tournament-configuration wire surface.
 */
export const MatchRefTarget = z.object({
  bracket: BracketSide,
  round: z.number().int().positive(),
  slot: z.number().int().nonnegative(),
});

export const SetMatchFormatsRequest = z.object({
  refs: z.array(MatchRefTarget).min(1),
  formatKey: FormatKey,
});
export type SetMatchFormatsRequest = z.infer<typeof SetMatchFormatsRequest>;

export const GuardCheck = z.object({ label: z.string(), ok: z.boolean() });
export type GuardCheck = z.infer<typeof GuardCheck>;

export const LifecycleStatus = z.object({
  state: TournamentState,
  name: z.string(),
  legalActions: z.array(LifecycleAction),
  /** Informational even outside `CHECKIN_CLOSED` — a TO can see what's still missing before it's even relevant. Includes whether a pre-generated bracket still matches the checked-in field. */
  startGuards: z.array(GuardCheck),
  /** The tournament's current default — stamped onto every match at generation that has no per-match override. */
  defaultFormatKey: FormatKey,
  /** False once the bracket is materialized at `RUNNING` — changing it after that point would not affect any already-generated match. A bracket generated earlier, at `CHECKIN_CLOSED`, does not close this on its own; see `MixedFormatConflictError`. */
  formatEditable: z.boolean(),
  /** The checked-in count the current bracket (if any) was generated for — `null` before `GENERATE_BRACKET` has ever run. Lets a client label its button "Generate" vs "Regenerate". */
  bracketEntrantCount: z.number().int().nonnegative().nullable(),
});
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;
