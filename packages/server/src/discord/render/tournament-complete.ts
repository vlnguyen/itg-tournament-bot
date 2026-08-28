import { EmbedBuilder } from 'discord.js';
import type { StandingsRow } from '../../services/advancement-service.js';
import { isAbsoluteWebUrl, tournamentUrl } from '../../web-url.js';
import type { RenderedMessage } from '../ports.js';
import { LOG_COLOR } from './draw.js';

/**
 * "The Discord post mirrors the match result feed — full placement order
 * to the results channel, forwarded to the general channel." See
 * DESIGN.md, "Results, Standings, and History". Capped at 8th place —
 * `computeTournamentStandings` already applies competition ranking (tied
 * players share a placement, the next placement skips), so this can render
 * anywhere from five to eight names depending on how the last spot shown
 * ties out, never a lone "8th" a differently-shaped bracket can't produce.
 *
 * The title itself is the link target (`setURL`) — same "whole title is
 * one hyperlink" constraint as `buildResultAnnouncement`, since Discord
 * embed titles render as plain text with no inline markdown.
 */
export function buildTournamentCompleteAnnouncement(
  tournamentId: string,
  tournamentName: string,
  standings: readonly StandingsRow[],
): RenderedMessage {
  const byPlace = new Map<number, StandingsRow[]>();
  for (const row of standings) {
    if (row.place > 8) continue;
    const rows = byPlace.get(row.place) ?? [];
    rows.push(row);
    byPlace.set(row.place, rows);
  }

  const lines = [...byPlace.entries()]
    .sort(([a], [b]) => a - b)
    .map(([place, rows]) => {
      const names = rows
        .sort((a, b) => a.seed - b.seed)
        .map((r) => r.displayName ?? r.entrantId)
        .join(' / ');
      return `**${place}.** ${names}`;
    });

  const link = tournamentUrl(tournamentId);
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${tournamentName}: Final Standings`)
    .setColor(LOG_COLOR.TOURNAMENT_COMPLETE)
    .setDescription(lines.length > 0 ? lines.join('\n') : 'No standings available.');
  if (isAbsoluteWebUrl(link)) embed.setURL(link);

  return { embeds: [embed] };
}
