import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F } from '../src/domain/bo5.js';
import type { MatchState, PendingAction } from '../src/domain/types.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import { appendMatchEvent, IllegalActionError } from '../src/services/match-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import {
  cleanupTournament,
  driveToCompletion,
  isReachable,
  makeTournament,
  playMatchToChampion,
  prisma,
  type TestTournament,
} from './support.js';

/**
 * Drives a real match through `appendMatchEvent`, against real Postgres.
 * Covers exactly what DESIGN.md's Testing Strategy table calls out as
 * impossible to check against a mock: concurrent appends serializing
 * through the row lock, dedupe-key idempotency, and a stale/illegal action
 * being rejected. Skipped when no database is reachable.
 */
describe.skipIf(!(await isReachable()))('match-service', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function currentPending(matchId: string): Promise<PendingAction> {
    const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    return F.pendingAction(m.state as unknown as MatchState);
  }

  async function twoPlayerMatch(guildId: string) {
    const t = await makeTournament(guildId, 2);
    const random = sequentialRandomPort(guildId);
    await materializeBracket(prisma, random, t.tournamentId);
    const match = await prisma.match.findFirstOrThrow({ where: { tournamentId: t.tournamentId } });
    return { t, random, matchId: match.id };
  }

  it('rejects an action that does not match the current pending action', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-illegal-${Date.now()}`);
    try {
      const pending = await currentPending(matchId);
      expect(pending.kind).toBe('SEED_CHOICE');
      const notTheChooser = t.entrantIds.find((id) => id !== (pending as { actor: string }).actor)!;
      await expect(
        appendMatchEvent(prisma, random, matchId, {
          actorId: notTheChooser,
          type: 'SEED_CHOICE_MADE',
          payload: { by: notTheChooser, order: 'FIRST' },
        }),
      ).rejects.toThrow(IllegalActionError);
    } finally {
      await cleanupTournament(t);
    }
  });

  it('is idempotent under a repeated dedupeKey', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-dedupe-${Date.now()}`);
    try {
      const pending = (await currentPending(matchId)) as Extract<PendingAction, { kind: 'SEED_CHOICE' }>;
      const event = {
        actorId: pending.actor,
        type: 'SEED_CHOICE_MADE' as const,
        payload: { by: pending.actor, order: 'FIRST' as const },
      };
      const first = await appendMatchEvent(prisma, random, matchId, event, 'interaction-1');
      const second = await appendMatchEvent(prisma, random, matchId, event, 'interaction-1');
      expect(second.state.seq).toBe(first.state.seq);
      const events = await prisma.matchEvent.findMany({ where: { matchId, type: 'SEED_CHOICE_MADE' } });
      expect(events).toHaveLength(1);
    } finally {
      await cleanupTournament(t);
    }
  });

  it('serializes two concurrent appends into distinct, ordered events', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-concurrent-${Date.now()}`);
    try {
      // Drive to song 0's SUBMIT_SCORE stage.
      const seedChoice = (await currentPending(matchId)) as Extract<PendingAction, { kind: 'SEED_CHOICE' }>;
      await appendMatchEvent(prisma, random, matchId, {
        actorId: seedChoice.actor,
        type: 'SEED_CHOICE_MADE',
        payload: { by: seedChoice.actor, order: 'FIRST' },
      });
      for (;;) {
        const p = await currentPending(matchId);
        if (p.kind !== 'PROTECT' && p.kind !== 'VETO') break;
        await appendMatchEvent(prisma, random, matchId, {
          actorId: p.actor,
          type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
          payload: { by: p.actor, drawIndex: p.choices[0]! },
        });
      }
      const submit = (await currentPending(matchId)) as Extract<PendingAction, { kind: 'SUBMIT_SCORE' }>;
      expect(submit.actors).toHaveLength(2);

      // Both players submit their score and photo concurrently.
      await Promise.all(
        submit.actors.map((actorId) =>
          appendMatchEvent(prisma, random, matchId, {
            actorId,
            type: 'SCORE_SUBMITTED',
            payload: { songIndex: submit.songIndex, by: actorId, ex: 90 },
          }).then(() =>
            appendMatchEvent(prisma, random, matchId, {
              actorId: null,
              type: 'PHOTO_OBSERVED',
              payload: { songIndex: submit.songIndex, by: actorId, messageId: `m-${actorId}` },
            }),
          ),
        ),
      );

      const events = await prisma.matchEvent.findMany({ where: { matchId }, orderBy: { seq: 'asc' } });
      const seqs = events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length); // every seq distinct
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b).map((_, i) => seqs[0]! + i)); // gap-free

      const select = await currentPending(matchId);
      expect(select.kind).toBe('SELECT_WINNER');

      // Both winner selections concurrently too — agreement commits the song.
      const [a, b] = submit.actors;
      await Promise.all([
        appendMatchEvent(prisma, random, matchId, {
          actorId: a!,
          type: 'SONG_WINNER_SELECTED',
          payload: { songIndex: submit.songIndex, by: a!, choice: a! },
        }),
        appendMatchEvent(prisma, random, matchId, {
          actorId: b!,
          type: 'SONG_WINNER_SELECTED',
          payload: { songIndex: submit.songIndex, by: b!, choice: a! },
        }),
      ]);

      const state = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      const domainState = state.state as unknown as MatchState;
      expect(domainState.songs[submit.songIndex]!.result).toEqual({ winner: a, by: 'AGREEMENT' });
    } finally {
      await cleanupTournament(t);
    }
  });

  it('marks the match COMPLETE and the tournament COMPLETE once a two-entrant set is decided', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-complete-${Date.now()}`);
    try {
      // Play straight through: whichever player is offered the choice always
      // wins their song, so the set ends 3-0 without needing a tiebreak.
      const seedChoice = (await currentPending(matchId)) as Extract<PendingAction, { kind: 'SEED_CHOICE' }>;
      const champion = seedChoice.actor;
      await appendMatchEvent(prisma, random, matchId, {
        actorId: champion,
        type: 'SEED_CHOICE_MADE',
        payload: { by: champion, order: 'FIRST' },
      });
      for (;;) {
        const p = await currentPending(matchId);
        if (p.kind !== 'PROTECT' && p.kind !== 'VETO') break;
        await appendMatchEvent(prisma, random, matchId, {
          actorId: p.actor,
          type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
          payload: { by: p.actor, drawIndex: p.choices[0]! },
        });
      }
      let lastResult: Awaited<ReturnType<typeof appendMatchEvent>> | undefined;
      for (;;) {
        const p = await currentPending(matchId);
        if (p.kind === 'DONE') break;
        if (p.kind === 'CONFIRM_RESULT') {
          for (const actorId of p.actors) {
            lastResult = await appendMatchEvent(prisma, random, matchId, {
              actorId,
              type: 'SET_RESULT_CONFIRMED',
              payload: { by: actorId, choice: champion },
            });
          }
          continue;
        }
        if (p.kind === 'SUBMIT_SCORE') {
          for (const actorId of p.actors) {
            await appendMatchEvent(prisma, random, matchId, {
              actorId,
              type: 'SCORE_SUBMITTED',
              payload: { songIndex: p.songIndex, by: actorId, ex: actorId === champion ? 95 : 90 },
            });
            await appendMatchEvent(prisma, random, matchId, {
              actorId: null,
              type: 'PHOTO_OBSERVED',
              payload: { songIndex: p.songIndex, by: actorId, messageId: `m-${actorId}-${p.songIndex}` },
            });
          }
          continue;
        }
        if (p.kind === 'SELECT_WINNER') {
          for (const actorId of p.actors) {
            await appendMatchEvent(prisma, random, matchId, {
              actorId,
              type: 'SONG_WINNER_SELECTED',
              payload: { songIndex: p.songIndex, by: actorId, choice: champion },
            });
          }
          continue;
        }
        throw new Error(`unexpected pending kind ${p.kind}`);
      }

      const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      expect(match.status).toBe('COMPLETE');
      expect(match.winnerId).toBe(champion);
      const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
      expect(tournament.state).toBe('COMPLETE');
      // The append that actually decided it reports the tournament
      // completion too — the signal `applyAppendResult` uses to post the
      // final-standings announcement alongside the ordinary result.
      expect(lastResult!.tournamentCompleted).toBe(true);
    } finally {
      await cleanupTournament(t);
    }
  });

  // No Discord command reaches `FORFEIT_APPLIED` any more — `/dq` scoped to
  // "this match" covers a plain forfeit too, see the DQ_APPLIED test below —
  // but the event stays legal and correctly advances the winner, reserved
  // for the organizer console's own forfeit action once it ships.
  it('resolves the match via FORFEIT_APPLIED and advances the winner', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-forfeit-${Date.now()}`);
    try {
      const [winner, loser] = t.entrantIds;
      const result = await appendMatchEvent(prisma, random, matchId, {
        actorId: 'referee-1',
        type: 'FORFEIT_APPLIED',
        payload: { winnerId: winner! },
      });

      const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      expect(match.status).toBe('COMPLETE');
      expect(match.winnerId).toBe(winner);
      const domainState = match.state as unknown as MatchState;
      expect(domainState.terminal).toEqual({ winnerId: winner, by: 'FORFEIT' });
      expect(result.tournamentCompleted).toBe(true); // 2-entrant field — this one match was the whole tournament

      // Rejected once the match is already decided — the same guard every
      // other terminal ruling gets.
      await expect(
        appendMatchEvent(prisma, random, matchId, {
          actorId: 'referee-1',
          type: 'DQ_APPLIED',
          payload: { playerId: loser!, scope: 'MATCH' },
        }),
      ).rejects.toThrow(IllegalActionError);
    } finally {
      await cleanupTournament(t);
    }
  });

  it('resolves the match via DQ_APPLIED scope MATCH and advances the survivor — the match-scope /dq path', async () => {
    const { t, random, matchId } = await twoPlayerMatch(`match-dq-${Date.now()}`);
    try {
      const [dqd, survivor] = t.entrantIds;
      const result = await appendMatchEvent(prisma, random, matchId, {
        actorId: 'referee-1',
        type: 'DQ_APPLIED',
        payload: { playerId: dqd!, scope: 'MATCH' },
      });

      const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      expect(match.status).toBe('COMPLETE');
      expect(match.winnerId).toBe(survivor);
      const domainState = match.state as unknown as MatchState;
      expect(domainState.terminal).toEqual({ winnerId: survivor, by: 'DQ' });
      expect(result.tournamentCompleted).toBe(true); // 2-entrant field — this one match was the whole tournament
    } finally {
      await cleanupTournament(t);
    }
  });

  describe('a losers-bracket slot fed by a winners-round-1 bye', () => {
    const findMatch = (
      tournamentId: string,
      bracket: 'WINNERS' | 'LOSERS' | 'GRAND_FINAL',
      round: number,
      slot: number,
    ) =>
      prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId, bracket, round, slot } },
        include: { events: { orderBy: { seq: 'asc' } } },
      });

    // The exact shape "RIP 12.5" hit live: 3 entrants means WR1 has a bye
    // (seed 1) alongside a real match (seed 2 vs seed 3). LR1's only slot
    // is fed by that bye's nonexistent loser and WR1's real loser — one
    // structurally live source, not two — so it must resolve the moment
    // its one possible occupant is seated, not wait forever for a second.
    it('walks the lone occupant over immediately, and the tournament reaches COMPLETE', async () => {
      const t = await makeTournament(`match-lr-bye-${Date.now()}`, 3);
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);
      const [seed1, seed2, seed3] = t.entrantIds;

      try {
        const wr1s0 = await findMatch(t.tournamentId, 'WINNERS', 1, 0);
        expect(wr1s0.status).toBe('COMPLETE'); // the bye, resolved at materialization
        expect(wr1s0.winnerId).toBe(seed1);

        const wr1s1 = await findMatch(t.tournamentId, 'WINNERS', 1, 1);
        await playMatchToChampion(wr1s1.id, seed2!, random); // seed3 drops to LR1

        const lr1 = await findMatch(t.tournamentId, 'LOSERS', 1, 0);
        expect(lr1.status).toBe('COMPLETE'); // resolved without ever reaching two participants
        expect(lr1.winnerId).toBe(seed3);
        expect(lr1.events.map((e) => e.type)).toEqual(['MATCH_CREATED', 'WALKOVER']);
        const lr1Participants = await prisma.matchParticipant.findMany({ where: { matchId: lr1.id } });
        expect(lr1Participants).toHaveLength(1); // its dead slot was never seated at all

        const wr2 = await findMatch(t.tournamentId, 'WINNERS', 2, 0);
        await playMatchToChampion(wr2.id, seed1!, random); // seed2 drops to the losers final

        const lr2 = await findMatch(t.tournamentId, 'LOSERS', 2, 0);
        const lr2Participants = await prisma.matchParticipant.findMany({ where: { matchId: lr2.id } });
        expect(lr2Participants.map((p) => p.entrantId).sort()).toEqual([seed2, seed3].sort());
        await playMatchToChampion(lr2.id, seed2!, random);

        const gf1 = await findMatch(t.tournamentId, 'GRAND_FINAL', 1, 0);
        await playMatchToChampion(gf1.id, seed1!, random); // winners finalist takes it in one — no reset

        const finished = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
        expect(finished.state).toBe('COMPLETE');
      } finally {
        await cleanupTournament(t);
      }
    });
  });

  describe('match-scope /dq mid-bracket', () => {
    // 3 has a single winners-round-1 bye (the exact "RIP 12.5" shape); 4 has
    // none at all; 5 has three, including the fully-dead losers-bracket slot
    // from the property test. A DQ partway through must not stall any of them.
    it('DQs a real WR1 participant and the tournament still reaches COMPLETE', { timeout: 20000 }, async () => {
      for (const n of [3, 4, 5]) {
        const t = await makeTournament(`match-dq-mid-${n}-${Date.now()}`, n);
        const random = sequentialRandomPort(t.guildId);
        await materializeBracket(prisma, random, t.tournamentId);
        try {
          const real = await prisma.match.findFirstOrThrow({
            where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, status: 'IN_PROGRESS' },
            include: { participants: true },
            orderBy: { slot: 'asc' },
          });
          const dqd = real.participants[0]!.entrantId;

          await appendMatchEvent(prisma, random, real.id, {
            actorId: 'referee-1',
            type: 'DQ_APPLIED',
            payload: { playerId: dqd, scope: 'MATCH' },
          });

          await driveToCompletion(t.tournamentId, t.entrantIds, random);

          const finished = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
          expect(finished.state, `n=${n}`).toBe('COMPLETE');
        } finally {
          await cleanupTournament(t);
        }
      }
    });
  });

  describe('the grand final and its reset', () => {
    const findMatch = (
      tournamentId: string,
      bracket: 'WINNERS' | 'LOSERS' | 'GRAND_FINAL',
      round: number,
      slot: number,
    ) =>
      prisma.match.findUniqueOrThrow({
        where: { tournamentId_bracket_round_slot: { tournamentId, bracket, round, slot } },
      });

    it('starts and decides the reset when the losers finalist wins game 1', async () => {
      const t = await makeTournament(`match-reset-${Date.now()}`, 4);
      const random = sequentialRandomPort(t.guildId);
      await materializeBracket(prisma, random, t.tournamentId);
      const [seed1, seed2, seed3] = t.entrantIds;

      try {
        // seed1 beats seed4, seed2 beats seed3 — seed3 and seed4 drop to LR1.
        const wr1s0 = await findMatch(t.tournamentId, 'WINNERS', 1, 0);
        await playMatchToChampion(wr1s0.id, seed1!, random);
        const wr1s1 = await findMatch(t.tournamentId, 'WINNERS', 1, 1);
        await playMatchToChampion(wr1s1.id, seed2!, random);

        // seed3 survives losers round 1.
        const lr1 = await findMatch(t.tournamentId, 'LOSERS', 1, 0);
        await playMatchToChampion(lr1.id, seed3!, random);

        // seed1 takes the winners final; seed2 drops to the losers final.
        const wr2 = await findMatch(t.tournamentId, 'WINNERS', 2, 0);
        await playMatchToChampion(wr2.id, seed1!, random);

        // seed2 beats seed3 to become the losers-bracket finalist.
        const lr2 = await findMatch(t.tournamentId, 'LOSERS', 2, 0);
        await playMatchToChampion(lr2.id, seed2!, random);

        const gf1 = await findMatch(t.tournamentId, 'GRAND_FINAL', 1, 0);
        const gf1Seats = await prisma.matchParticipant.findMany({ where: { matchId: gf1.id } });
        expect(gf1Seats.map((p) => p.entrantId).sort()).toEqual([seed1, seed2].sort());

        // The losers-bracket finalist (seed2) takes game 1 — a reset is required.
        await playMatchToChampion(gf1.id, seed2!, random);

        const reset = await findMatch(t.tournamentId, 'GRAND_FINAL', 2, 0);
        expect(reset.status).toBe('IN_PROGRESS');
        const resetSeats = await prisma.matchParticipant.findMany({ where: { matchId: reset.id } });
        expect(resetSeats.map((p) => p.entrantId).sort()).toEqual([seed1, seed2].sort());

        const midway = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
        expect(midway.state).toBe('RUNNING'); // not decided until the reset resolves

        // seed1 takes the reset and the title.
        await playMatchToChampion(reset.id, seed1!, random);

        const resolvedReset = await prisma.match.findUniqueOrThrow({ where: { id: reset.id } });
        expect(resolvedReset.status).toBe('COMPLETE');
        expect(resolvedReset.winnerId).toBe(seed1);

        const finished = await prisma.tournament.findUniqueOrThrow({ where: { id: t.tournamentId } });
        expect(finished.state).toBe('COMPLETE');
      } finally {
        await cleanupTournament(t);
      }
    });
  });
});
