import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId } from '../../domain/types.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * Each player names who they believe won the set — the bot shows the
 * points its own math implies but does not preselect, the same reasoning
 * as winner selection for a single song: "the committing fact is
 * agreement, not arithmetic." Two disagreeing picks escalate to a referee
 * exactly like a song's would. See DESIGN.md, "Scoring a song" and the
 * event catalog's `SET_RESULT_CONFIRMED`.
 */
export function buildConfirmResultMessage(
  matchId: string,
  points: Record<EntrantId, number>,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
): RenderedMessage {
  const comparison = participantIds.map((id) => `**${nameOf(id)}**: ${points[id] ?? 0}`).join('   ·   ');

  const embed = new EmbedBuilder()
    .setTitle('Who won the set?')
    .setDescription(`${comparison}\n\nBoth players confirm before the match closes out.`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...participantIds.map((id) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ matchId, action: Action.CONFIRM, arg: id }))
        .setLabel(nameOf(id))
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return { embeds: [embed], components: [row] };
}
