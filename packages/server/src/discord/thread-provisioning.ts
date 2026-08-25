import type { PrismaClient } from '@prisma/client';
import type { MatchState } from '../domain/types.js';
import { requireFormat } from '../services/engine.js';
import type { MatchChannelPort, PlayerNotificationPort, ThreadRef } from './ports.js';
import { buildDrawEmbed } from './render/draw.js';
import { renderStateMessage, type PlayerDirectory } from './state-message.js';
import { formatThreadName } from './thread-name.js';

/**
 * "Round 1 of a 32-entrant tournament creates 16 private threads at once...
 * Provisioning runs through a serialized queue... keyed by match ID and
 * idempotent: a match with a `threadId` is skipped." See DESIGN.md,
 * "Thread provisioning". `discord.js`'s own REST manager already queues
 * and backs off on 429; processing matches one at a time — rather than
 * `Promise.all`-ing the whole batch — is what keeps a round's burst from
 * flooding it in the first place, and is the "serialized" half of the
 * design's requirement.
 *
 * A "ready" match is `IN_PROGRESS` (`MATCH_CREATED` has landed — two real,
 * non-withdrawn participants, per `services/engine.ts`) with no `threadId`
 * yet, **within the given tournament** — scoped explicitly, never a bare
 * scan of every match in the database, since this runs on a shared
 * Postgres instance alongside whatever else is using it. Nothing runs this
 * off a real lifecycle command this phase; it's called explicitly after
 * `materializeBracket`, same as the verification harness calls both.
 */
export async function provisionReadyThreads(
  prisma: PrismaClient,
  matchChannel: MatchChannelPort,
  playerNotification: PlayerNotificationPort,
  tournamentId: string,
  /**
   * Prepended to every thread name. Only ever set by the verification
   * harness — `'(Test) '`, so a thread this phase creates is unmistakably
   * not a real match while `/setup` and real lifecycle commands don't
   * exist yet to make that obvious any other way.
   */
  titlePrefix = '',
): Promise<ThreadRef[]> {
  const ready = await prisma.match.findMany({
    where: { tournamentId, status: 'IN_PROGRESS', threadId: null },
    include: { participants: { include: { entrant: true } } },
  });

  const provisioned: ThreadRef[] = [];
  for (const match of ready) {
    if (match.participants.length !== 2) continue; // defensive; should never be IN_PROGRESS otherwise

    const [p0, p1] = [...match.participants].sort((a, b) => a.slot - b.slot);
    const title =
      titlePrefix +
      formatThreadName(
        match.bracket,
        match.round,
        p0!.entrant.displayName ?? p0!.entrant.discordUserId,
        p1!.entrant.displayName ?? p1!.entrant.discordUserId,
      );
    const playerIds = [p0!.entrant.discordUserId, p1!.entrant.discordUserId];

    const ref = await matchChannel.createMatchThread({ matchId: match.id, title });
    await prisma.match.update({ where: { id: match.id }, data: { threadId: ref.threadId } });
    await playerNotification.matchReady(playerIds, ref);

    // "The Draw is revealed before the higher seed chooses" — both are
    // already settled in `match.state` by the time a match reaches
    // IN_PROGRESS (bracket-service's bot loop drew and folded them), so
    // opening the thread is purely a render of what's already decided, not
    // a new domain event. See DESIGN.md, "Opening the match".
    const state = match.state as unknown as MatchState;
    const format = requireFormat(match.formatKey);
    const players: PlayerDirectory = new Map(
      match.participants.map((p) => [p.entrantId, { discordUserId: p.entrant.discordUserId, displayName: p.entrant.displayName ?? p.entrant.discordUserId }]),
    );

    await matchChannel.postLogMessage(ref, { embeds: [buildDrawEmbed(state.draw)] });
    await matchChannel.postMatchState(ref, renderStateMessage(match.id, format.pendingAction(state), state, players));

    provisioned.push(ref);
  }
  return provisioned;
}
