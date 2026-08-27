import { z } from 'zod';
import { EntrantId } from './match.js';

/**
 * `POST /api/matches/:id/rulings` — DESIGN.md's route table: "Referee
 * overrides, guarded by the freeze predicate." The same four referee
 * actions available from Discord's ruling buttons and `/dq` (match
 * scope) — "an override that is illegal in the web UI is illegal from an
 * alert-channel button," which only holds if it's the *same* set of
 * actions reaching the *same* validation. Tournament-scope `/dq` isn't
 * here: it isn't a match-scoped ruling, it acts on a tournament.
 * `FORFEIT_APPLIED` isn't offered either — no transport emits it; "a
 * plain forfeit... is `/dq` scoped to this match only," i.e. `DQ_APPLIED`,
 * per DESIGN.md's "Ending a match by referee ruling."
 */
export const RulingRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SONG_RULED'),
    songIndex: z.number().int().nonnegative(),
    result: z.union([EntrantId, z.literal('TIE'), z.literal('VOID')]),
  }),
  z.object({ type: z.literal('PROTECT_VETO_RESET'), reason: z.string().min(1) }),
  z.object({ type: z.literal('SET_RESULT_RULED'), result: EntrantId }),
  z.object({ type: z.literal('DQ_APPLIED'), playerId: EntrantId }),
]);
export type RulingRequest = z.infer<typeof RulingRequest>;
