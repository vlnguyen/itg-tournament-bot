import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId, SongRecord } from '../../domain/types.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';
import { compactChartLabel } from './chart.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * "The bot displays the comparison its own numbers imply but does not
 * preselect — the committing fact is agreement, not arithmetic." Three
 * buttons: each player, or a tie. See DESIGN.md, "Scoring a song".
 */
export function buildWinnerSelectMessage(
  matchId: string,
  songIndex: number,
  song: Pick<SongRecord, 'chart' | 'ex'>,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
): RenderedMessage {
  const comparison = participantIds
    .map((id) => `**${nameOf(id)}**: ${song.ex[id]!.toFixed(2)}%`)
    .join('   ·   ');

  const embed = new EmbedBuilder()
    .setTitle(`Song ${songIndex + 1} — who won?`)
    .setDescription(`${compactChartLabel(song.chart)}\n\n${comparison}`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...participantIds.map((id) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ matchId, action: Action.WINNER, arg: id }))
        .setLabel(nameOf(id))
        .setStyle(ButtonStyle.Primary),
    ),
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.WINNER, arg: 'TIE' }))
      .setLabel('Tie')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}
