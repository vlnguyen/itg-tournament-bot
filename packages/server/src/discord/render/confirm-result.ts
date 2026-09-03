import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId } from '../../domain/types.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/** Average EX% across every song a player submitted a score for — `undefined` with none, never `NaN`. */
function averageEx(songs: readonly { ex: Partial<Record<EntrantId, number>> }[], id: EntrantId): number | undefined {
  const values = songs.map((s) => s.ex[id]).filter((v): v is number => v !== undefined);
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Each player names who they believe won the set — the bot shows the
 * points its own math implies but does not preselect, the same reasoning
 * as winner selection for a single song: "the committing fact is
 * agreement, not arithmetic." Two disagreeing picks escalate to a referee
 * exactly like a song's would. See DESIGN.md, "Scoring a song" and the
 * event catalog's `SET_RESULT_CONFIRMED`.
 *
 * Average EX% rides along next to points — Hubert's format falls back to
 * it once points are tied (`decisiveWinner`'s next tiebreaker), so it's
 * exactly the number a player or referee needs to see to understand why a
 * particular winner makes sense, not just trust the buttons.
 */
export function buildConfirmResultMessage(
  matchId: string,
  points: Record<EntrantId, number>,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
  songs: readonly { ex: Partial<Record<EntrantId, number>> }[] = [],
): RenderedMessage {
  const comparison = participantIds
    .map((id) => {
      const avg = averageEx(songs, id);
      const suffix = avg === undefined ? '' : ` (avg. ${avg.toFixed(2)}%)`;
      return `**${nameOf(id)}**: ${points[id] ?? 0}${suffix}`;
    })
    .join('   ·   ');

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
