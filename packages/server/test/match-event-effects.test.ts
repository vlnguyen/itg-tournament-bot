import { PublicMatch as PublicMatchSchema } from '@itg/shared';
import type { PublicMatch as DomainPublicMatch } from '../src/domain/projection.js';
import { describe, expect, it } from 'vitest';
import { applyAppendResult } from '../src/discord/match-event-effects.js';
import { loadMatch } from '../src/discord/match-lookup.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, RenderedMessage } from '../src/discord/ports.js';
import { requireFormat } from '../src/services/engine.js';
import { appendMatchEvent } from '../src/services/match-service.js';
import { materializeBracket } from '../src/services/bracket-service.js';
import type { RealtimeBroadcastPort } from '../src/services/ports.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { cleanupTournament, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

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
