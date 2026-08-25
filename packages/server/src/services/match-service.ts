import type { PrismaClient } from '@prisma/client';
import { isLegal } from '../domain/validate.js';
import type { DomainEffect, MatchEvent, MatchOutcome, MatchState, PendingAction } from '../domain/types.js';
import type { RandomPort } from './ports.js';
import { appendOne, lockAndLoadMatch, persistAndCascade, settleBotLoop, type Tx } from './engine.js';

export class IllegalActionError extends Error {
  constructor(
    readonly matchId: string,
    readonly pending: PendingAction,
    readonly attempted: Omit<MatchEvent, 'seq'>,
  ) {
    super(`match ${matchId}: ${attempted.type} is not legal while pending is ${pending.kind}`);
    this.name = 'IllegalActionError';
  }
}

export interface AppendResult {
  state: MatchState;
  outcome: MatchOutcome | null;
  /**
   * What just became true, for a caller to act on — "returning a
   * *description* of what to do keeps it pure and testable." See
   * DESIGN.md, "Match Format as a Plugin". Empty on a dedupe-hit: nothing
   * new happened as a result of *this* call.
   */
  effects: DomainEffect[];
}

/**
 * The one call a transport makes: "here is what actually happened, make it
 * so." Validates the action against `pendingAction(state)` — "an action is
 * legal iff its actor and value appear in the current `PendingAction`" — then
 * appends it, settles the bot's side of the set, and (if the set was just
 * decided) runs the advancement cascade, all inside one transaction holding
 * the match's row lock. See DESIGN.md, "Concurrency, Ordering, and
 * Idempotency".
 */
export async function appendMatchEventTx(
  tx: Tx,
  random: RandomPort,
  matchId: string,
  event: Omit<MatchEvent, 'seq'>,
  dedupeKey?: string,
): Promise<AppendResult> {
  if (dedupeKey) {
    const existing = await tx.matchEvent.findUnique({
      where: { matchId_dedupeKey: { matchId, dedupeKey } },
    });
    if (existing) {
      // "A duplicate append fails on the unique index and is treated as
      // success — the user already did this, and the outcome they wanted is
      // already recorded." Checked first rather than caught after, since
      // we're already inside the locked transaction either way.
      const { state, format } = await lockAndLoadMatch(tx, matchId);
      return { state, outcome: format.outcome(state), effects: [] };
    }
  }

  const { match, state, format, ref } = await lockAndLoadMatch(tx, matchId);
  const pending = format.pendingAction(state);
  const probe = { ...event, seq: state.seq + 1 } as MatchEvent;
  if (!isLegal(pending, probe)) {
    throw new IllegalActionError(matchId, pending, event);
  }

  const afterAction = await appendOne(tx, matchId, state, format, event, dedupeKey);
  const settled = await settleBotLoop(tx, match.tournamentId, random, matchId, afterAction, format);
  await persistAndCascade(tx, match.tournamentId, ref, matchId, format, random, state, settled);

  return { state: settled, outcome: format.outcome(settled), effects: format.effects(state, settled) };
}

export async function appendMatchEvent(
  prisma: PrismaClient,
  random: RandomPort,
  matchId: string,
  event: Omit<MatchEvent, 'seq'>,
  dedupeKey?: string,
): Promise<AppendResult> {
  return prisma.$transaction((tx) => appendMatchEventTx(tx, random, matchId, event, dedupeKey));
}
