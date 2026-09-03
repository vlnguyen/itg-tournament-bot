import { PublicMatch as PublicMatchSchema } from '@itg/shared';
import type { PublicMatch as DomainPublicMatch } from '../src/domain/projection.js';
import { describe, expect, it } from 'vitest';
import { applyAppendResult, describeStale } from '../src/discord/match-event-effects.js';
import { loadMatch } from '../src/discord/match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, RenderedMessage } from '../src/discord/ports.js';
import type { PlayerDirectory } from '../src/discord/state-message.js';
import { requireFormat } from '../src/services/engine.js';
import { appendMatchEvent, IllegalActionError } from '../src/services/match-service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import type { RealtimeBroadcastPort } from '../src/services/ports.js';
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
});
