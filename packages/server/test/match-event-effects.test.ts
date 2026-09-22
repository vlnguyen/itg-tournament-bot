import { PublicMatch as PublicMatchSchema } from '@itg/shared';
import type { PublicMatch as DomainPublicMatch } from '../src/domain/projection.js';
import type { MatchEvent, MatchState } from '../src/domain/types.js';
import { describe, expect, it } from 'vitest';
import { applyAppendResult, describeStale } from '../src/discord/match-event-effects.js';
import { loadMatch } from '../src/discord/match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, RenderedMessage } from '../src/discord/ports.js';
import type { PlayerDirectory } from '../src/discord/state-message.js';
import { requireFormat } from '../src/services/engine.js';
import { appendMatchEvent, IllegalActionError } from '../src/services/match-service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import type { RandomPort, RealtimeBroadcastPort } from '../src/services/ports.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { cleanupTournament, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

/**
 * `describeStale` names what the match is actually waiting on — "Waiting
 * for Hubert to pick a song" — rather than the raw pending kind
 * ("it's waiting on select song"). Pure, no DB needed.
 */
describe('describeStale', () => {
  const players: PlayerDirectory = new Map([
    ['alice', { discordUserId: 'd-alice', displayName: 'VincentITG' }],
    ['bob', { discordUserId: 'd-bob', displayName: 'Hubert' }],
  ]);

  it("names the actor for an out-of-turn action (Hubert's SELECT_SONG)", () => {
    const err = new IllegalActionError('m1', { kind: 'SELECT_SONG', actor: 'bob', choices: [0] }, {
      actorId: 'd-alice',
      type: 'CHART_SELECTED',
      payload: { by: 'alice', drawIndex: 0 },
    });
    expect(describeStale(err, players)).toBe('Waiting for Hubert to pick a song.');
  });

  it('joins two actors with "and" for SUBMIT_SCORE/SELECT_WINNER/CONFIRM_RESULT', () => {
    const submitScore = new IllegalActionError('m1', { kind: 'SUBMIT_SCORE', actors: ['alice', 'bob'], songIndex: 0 }, {
      actorId: 'd-alice',
      type: 'SONG_WINNER_SELECTED',
      payload: { songIndex: 0, by: 'alice', choice: 'alice' },
    });
    expect(describeStale(submitScore, players)).toBe('Waiting for VincentITG and Hubert to submit EX%.');
  });

  it('never names who for a hidden TIEBREAK_PICK', () => {
    const err = new IllegalActionError('m1', { kind: 'TIEBREAK_PICK', actors: ['alice'], round: 1, choices: [0] }, {
      actorId: 'd-bob',
      type: 'CHART_VETOED',
      payload: { by: 'bob', drawIndex: 0 },
    });
    expect(describeStale(err, players)).toBe('Waiting for a tiebreak pick.');
  });

  it('reports a decided match plainly', () => {
    const err = new IllegalActionError('m1', { kind: 'DONE' }, {
      actorId: 'd-alice',
      type: 'CHART_VETOED',
      payload: { by: 'alice', drawIndex: 0 },
    });
    expect(describeStale(err, players)).toBe('The match is already decided.');
  });
});

/**
 * Regression test for a real bug: `toPublicMatch` never sets
 * `participants[].displayName` (see `projection-wire-schema.test.ts`'s own
 * `withNames` comment — every caller has to join it in), but
 * `RealtimeGateway.publish` validates its argument against
 * `PublicMatchSchema`, which requires that field. `applyAppendResult`
 * called `realtime.publish` with the raw, unenriched projection, so every
 * single live match action threw a `ZodError` there — the *first*
 * statement in the function — which silently aborted everything after it:
 * the action log, the re-rendered state message, escalation alerts,
 * thread provisioning. A player's click would commit to the database and
 * then visibly do nothing, forever, because the prompt for the next step
 * never got rendered. This suite is what would have caught it: nothing
 * else in the test suite drives a real match through `applyAppendResult`
 * at all (`match-service.test.ts` calls `appendMatchEvent` directly).
 */
describe.skipIf(!(await isReachable()))('applyAppendResult', () => {
  const fakeMatchChannel: MatchChannelPort = {
    createMatchThread: async () => ({ matchId: '', threadId: 'fake-thread' }),
    postLogMessage: async () => undefined,
    postMatchState: async () => undefined,
    archiveThread: async () => undefined,
    lockThread: async () => undefined,
    applyTournamentStatus: async () => undefined,
    publishResult: async () => undefined,
  };
  const fakeAlert: AlertPort = {
    raise: async () => ({ messageId: 'fake-alert' }),
    resolve: async () => undefined,
  };
  const fakePlayerNotification: PlayerNotificationPort = {
    matchReady: async () => undefined,
    checkinOpened: async () => ({ unreachable: [] }),
    registrationOpened: async () => undefined,
    entrantJoined: async () => undefined,
    entrantCheckedIn: async () => undefined,
    tournamentCancelled: async () => undefined,
    checkinClosed: async () => undefined,
    tournamentStarted: async () => undefined,
    eliminated: async () => ({ reached: true }),
  };

  it('publishes a schema-valid, name-enriched projection and still renders the state message afterward', async () => {
    const t: TestTournament = await makeTournament(`effects-${Date.now()}`, 2);
    try {
      await materializeBracket(prisma, sequentialRandomPort('effects'), t.tournamentId);
      const match = await prisma.match.findFirstOrThrow({ where: { tournamentId: t.tournamentId } });
      const withParticipants = await loadMatch(prisma, match.id);
      if (!withParticipants) throw new Error('unreachable');
      const format = requireFormat(withParticipants.formatKey);

      const higherSeed = withParticipants.participants.find((p) => p.entrantId === t.entrantIds[0])!.entrantId;
      const event = { actorId: higherSeed, type: 'SEED_CHOICE_MADE' as const, payload: { by: higherSeed, order: 'FIRST' as const } };
      const result = await appendMatchEvent(prisma, sequentialRandomPort('effects-event'), match.id, event);

      let published: DomainPublicMatch | undefined;
      const capturingRealtime: RealtimeBroadcastPort = {
        publish: (_tournamentId, _matchId, _seq, projection) => {
          published = projection;
        },
        publishRosterChanged: () => undefined,
        publishLifecycleChanged: () => undefined,
      };
      let renderedFinalState: RenderedMessage | undefined;
      const capturingMatchChannel: MatchChannelPort = {
        ...fakeMatchChannel,
        postMatchState: async (_ref, message) => {
          renderedFinalState = message;
        },
      };

      await applyAppendResult(
        prisma,
        capturingMatchChannel,
        fakeAlert,
        fakePlayerNotification,
        capturingRealtime,
        withParticipants,
        format,
        event,
        result,
      );

      // The bug: this used to throw before `published` was ever set, and
      // `postMatchState` (below) never ran.
      const wire = PublicMatchSchema.parse(published);
      expect(wire.participants.every((p) => p.displayName.length > 0)).toBe(true);

      // The interface actually moved on to the next step, instead of being
      // stuck showing the seed-choice prompt forever.
      expect(renderedFinalState).toBeDefined();
      expect(JSON.stringify(renderedFinalState)).toMatch(/protect|veto/i);
    } finally {
      await cleanupTournament(t);
    }
  });

  /**
   * Same step loop as `support.ts`'s `playMatchToChampion`, but running
   * each event through `applyAppendResult` (not just `appendMatchEvent`)
   * so the Discord effects under test — thread lock/archive, elimination
   * DMs — actually fire. Drives exactly one match; the caller decides
   * which one and what to capture.
   */
  async function playMatchThroughEffects(
    matchId: string,
    championEntrantId: string,
    random: RandomPort,
    matchChannel: MatchChannelPort,
    playerNotification: PlayerNotificationPort = fakePlayerNotification,
  ): Promise<void> {
    const noopRealtime: RealtimeBroadcastPort = {
      publish: () => undefined,
      publishRosterChanged: () => undefined,
      publishLifecycleChanged: () => undefined,
    };
    for (;;) {
      const withParticipants = await loadMatch(prisma, matchId);
      if (!withParticipants) throw new Error('unreachable');
      const format = requireFormat(withParticipants.formatKey);
      const pending = format.pendingAction(withParticipants.state as unknown as MatchState);
      if (pending.kind === 'DONE') return;

      const events: Omit<MatchEvent, 'seq'>[] = [];
      switch (pending.kind) {
        case 'SEED_CHOICE':
          events.push({ actorId: pending.actor, type: 'SEED_CHOICE_MADE', payload: { by: pending.actor, order: 'FIRST' } });
          break;
        case 'PROTECT':
        case 'VETO':
          events.push({
            actorId: pending.actor,
            type: pending.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
            payload: { by: pending.actor, drawIndex: pending.choices[0]! },
          });
          break;
        case 'SUBMIT_SCORE':
          for (const actorId of pending.actors) {
            events.push({
              actorId,
              type: 'SCORE_SUBMITTED',
              payload: { songIndex: pending.songIndex, by: actorId, ex: actorId === championEntrantId ? 95 : 90 },
            });
            events.push({
              actorId: null,
              type: 'PHOTO_OBSERVED',
              payload: { songIndex: pending.songIndex, by: actorId, messageId: `m-${actorId}-${pending.songIndex}` },
            });
          }
          break;
        case 'SELECT_WINNER':
          for (const actorId of pending.actors) {
            events.push({ actorId, type: 'SONG_WINNER_SELECTED', payload: { songIndex: pending.songIndex, by: actorId, choice: championEntrantId } });
          }
          break;
        case 'CONFIRM_RESULT':
          for (const actorId of pending.actors) {
            events.push({ actorId, type: 'SET_RESULT_CONFIRMED', payload: { by: actorId, choice: championEntrantId } });
          }
          break;
        default:
          throw new Error(`unexpected pending kind ${pending.kind}`);
      }

      for (const event of events) {
        const before = await loadMatch(prisma, matchId);
        if (!before) throw new Error('unreachable');
        const result = await appendMatchEvent(prisma, random, matchId, event);
        await applyAppendResult(prisma, matchChannel, fakeAlert, playerNotification, noopRealtime, before, format, event, result);
      }
    }
  }

  it('locks the thread before archiving it on normal completion', async () => {
    const t: TestTournament = await makeTournament(`effects-lock-${Date.now()}`, 2);
    try {
      const random = sequentialRandomPort('effects-lock');
      await materializeBracket(prisma, random, t.tournamentId);
      const match = await prisma.match.findFirstOrThrow({ where: { tournamentId: t.tournamentId } });

      const calls: string[] = [];
      const capturingMatchChannel: MatchChannelPort = {
        ...fakeMatchChannel,
        lockThread: async () => {
          calls.push('lockThread');
        },
        archiveThread: async () => {
          calls.push('archiveThread');
        },
      };

      await playMatchThroughEffects(match.id, t.entrantIds[0]!, random, capturingMatchChannel);

      expect(calls).toEqual(['lockThread', 'archiveThread']);
    } finally {
      await cleanupTournament(t);
    }
  });

  describe('elimination DMs', () => {
    it('does not notify a winners-bracket loser — they drop to the losers bracket instead', async () => {
      const t: TestTournament = await makeTournament(`effects-elim-wr-${Date.now()}`, 4);
      try {
        const random = sequentialRandomPort('effects-elim-wr');
        await materializeBracket(prisma, random, t.tournamentId);
        const wr1 = await prisma.match.findFirstOrThrow({
          where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1, status: 'IN_PROGRESS' },
          include: { participants: true },
          orderBy: { slot: 'asc' },
        });
        const winner = wr1.participants[0]!.entrantId;

        const eliminatedIds: string[] = [];
        const capturingNotification: PlayerNotificationPort = {
          ...fakePlayerNotification,
          eliminated: async (discordUserId) => {
            eliminatedIds.push(discordUserId);
            return { reached: true };
          },
        };

        await playMatchThroughEffects(wr1.id, winner, random, fakeMatchChannel, capturingNotification);

        expect(eliminatedIds).toEqual([]);
      } finally {
        await cleanupTournament(t);
      }
    });

    it('notifies a losers-bracket loser — there is no forward edge for them to be routed to', async () => {
      const t: TestTournament = await makeTournament(`effects-elim-lr-${Date.now()}`, 4);
      try {
        const random = sequentialRandomPort('effects-elim-lr');
        await materializeBracket(prisma, random, t.tournamentId);

        const eliminatedIds: string[] = [];
        const capturingNotification: PlayerNotificationPort = {
          ...fakePlayerNotification,
          eliminated: async (discordUserId) => {
            eliminatedIds.push(discordUserId);
            return { reached: true };
          },
        };

        // Both WR1 matches feed the sole LR1 match — play them out (through
        // the real port, no elimination expected from either) to seat it.
        const wr1Matches = await prisma.match.findMany({
          where: { tournamentId: t.tournamentId, bracket: 'WINNERS', round: 1 },
          include: { participants: true },
          orderBy: { slot: 'asc' },
        });
        for (const m of wr1Matches) {
          await playMatchThroughEffects(m.id, m.participants[0]!.entrantId, random, fakeMatchChannel, capturingNotification);
        }
        expect(eliminatedIds).toEqual([]); // sanity: winners-round losses still didn't notify

        const lr1 = await prisma.match.findFirstOrThrow({
          where: { tournamentId: t.tournamentId, bracket: 'LOSERS', round: 1 },
          include: { participants: true },
        });
        const [loser, winner] = lr1.participants.map((p) => p.entrantId);
        const loserEntrant = await prisma.entrant.findUniqueOrThrow({ where: { id: loser! } });

        await playMatchThroughEffects(lr1.id, winner!, random, fakeMatchChannel, capturingNotification);

        expect(eliminatedIds).toEqual([loserEntrant.discordUserId]);
      } finally {
        await cleanupTournament(t);
      }
    });

    // A grand-final loss is never checked separately: `match.bracket` can
    // only ever be `'LOSERS'`, `'WINNERS'`, or `'GRAND_FINAL'` — the
    // elimination check above is scoped to `=== 'LOSERS'`, so a grand-final
    // match structurally can never reach it, not just by convention.
  });
});
