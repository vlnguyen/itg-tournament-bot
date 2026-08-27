import { Events, type Client, type Message } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { MatchState } from '../domain/types.js';
import { toPublicMatch } from '../domain/projection.js';
import { requireFormat } from '../services/engine.js';
import { appendMatchEvent, IllegalActionError } from '../services/match-service.js';
import type { RandomPort, RealtimeBroadcastPort } from '../services/ports.js';
import { buildPlayerDirectory, loadMatchByThreadId } from './match-lookup.js';
import type { MatchChannelPort, ThreadRef } from './ports.js';
import { displayName, renderStateMessage } from './state-message.js';

/**
 * "The first message from a player carrying an image attachment satisfies
 * their photo requirement for the current song. Extras are ignored, images
 * posted when nothing is outstanding are ignored, and the order against
 * the EX% submission does not matter." See DESIGN.md, "Scoring a song".
 *
 * Nothing here decides whether a photo is *owed* — `isLegal` does, inside
 * `appendMatchEvent`, exactly as it does for every other action. A photo
 * that arrives with nothing outstanding is rejected the same way a stale
 * button is, just silently: there's no interaction to answer here.
 */
export function registerMessageListener(
  client: Client,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  realtime: RealtimeBroadcastPort,
): void {
  client.on(Events.MessageCreate, (message: Message) => {
    handle(message, prisma, random, matchChannel, realtime).catch((err: unknown) => {
      console.error('[discord] message handler failed', err);
    });
  });
}

async function handle(
  message: Message,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  if (message.author.bot) return; // ignore the bot's own messages — including its own reposts
  if (!message.channel.isThread()) return;

  const hasImage = message.attachments.some((a) => a.contentType?.startsWith('image/'));
  if (!hasImage) return;

  const match = await loadMatchByThreadId(prisma, message.channel.id);
  if (!match) return; // not a match thread

  const me = match.participants.find((p) => p.entrant.discordUserId === message.author.id);
  if (!me) return; // not a participant — one competitor's photo can't satisfy the other's requirement

  const format = requireFormat(match.formatKey);
  const before = match.state as unknown as MatchState;
  const pending = format.pendingAction(before);
  if (pending.kind !== 'SUBMIT_SCORE') return; // nothing outstanding to attach this photo to

  try {
    const result = await appendMatchEvent(
      prisma,
      random,
      match.id,
      {
        actorId: null,
        type: 'PHOTO_OBSERVED',
        payload: { songIndex: pending.songIndex, by: me.entrantId, messageId: message.id },
      },
      message.id, // a message can only ever satisfy its own photo requirement once
    );

    // `toPublicMatch` never sets `participants[].displayName` — every
    // caller has to join it in (see `match-event-effects.ts`'s comment on
    // its own `realtime.publish` call, the same fix applied here).
    const players = buildPlayerDirectory(match);
    const projection = toPublicMatch(format, result.state);
    realtime.publish(match.tournamentId, match.id, result.state.seq, {
      ...projection,
      bracket: match.bracket,
      round: match.round,
      participants: projection.participants.map((p) => ({ ...p, displayName: displayName(players, p.entrantId) })),
    });

    const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
    const newPending = format.pendingAction(result.state);
    await matchChannel.postMatchState(ref, renderStateMessage(match.id, newPending, result.state, players));
  } catch (err) {
    // "Images posted when nothing is outstanding are ignored" — the race
    // between the read above and this append landing on a now-closed
    // window is exactly that case, not a real error.
    if (err instanceof IllegalActionError) return;
    throw err;
  }
}
