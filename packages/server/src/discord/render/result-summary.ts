import { EmbedBuilder } from 'discord.js';
import type { BracketSide } from '@itg/shared';
import type { EntrantId, MatchOutcome } from '../../domain/types.js';
import type { PublicMatch } from '../../domain/projection.js';
import type { RenderedMessage } from '../ports.js';
import { compactChartLabel } from './chart.js';
import { LOG_COLOR } from './draw.js';
import { roundLabel } from '../thread-name.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/** How the set was decided, worded for a one-line summary. `''` for the ordinary case — nothing to call out. */
const DECIDED_BY: Record<MatchOutcome['by'], string> = {
  AGREEMENT: '',
  RULING: 'by referee ruling',
  FORFEIT: 'by forfeit',
  DQ: 'by disqualification',
  WALKOVER: 'by walkover',
};

function songLine(song: PublicMatch['songs'][number], participantIds: readonly EntrantId[], nameOf: NameLookup): string {
  const label = song.tiebreakRound !== undefined ? `Tiebreak ${song.tiebreakRound}` : `Song ${song.index + 1}`;
  const scoreText = participantIds
    .filter((id) => song.ex[id] !== undefined)
    .map((id) => `${nameOf(id)} ${song.ex[id]!.toFixed(2)}%`)
    .join(' — ');
  const result = song.result;
  const outcomeText = !result
    ? ''
    : result.winner === 'TIE'
      ? 'tied'
      : result.winner === 'VOID'
        ? 'voided'
        : `${nameOf(result.winner)} wins`;
  const parts = [scoreText, outcomeText].filter((v) => v.length > 0).join(' — ');
  return `**${label}** — ${compactChartLabel(song.chart)}${parts ? `: ${parts}` : ''}`;
}

/**
 * "The result summary is a log message and the last thing the bot posts:
 * songs in play order with both EX% values and the winner of each,
 * tiebreak rounds if any, and the final score." See DESIGN.md, "Ending the
 * match" — rendered from `toPublicMatch`, the same projection a public
 * page would use, so the thread and that page can't disagree.
 */
export function buildResultSummaryEmbed(
  songs: PublicMatch['songs'],
  points: Record<EntrantId, number>,
  outcome: MatchOutcome,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
): EmbedBuilder {
  const winner = outcome.placements.find((p) => p.place === 1)!;
  const [a, b] = participantIds;
  const decidedBy = DECIDED_BY[outcome.by];

  return new EmbedBuilder()
    .setTitle(`Match complete — ${nameOf(winner.entrantId)} wins ${points[a] ?? 0}–${points[b] ?? 0}${decidedBy ? ` (${decidedBy})` : ''}`)
    .setColor(LOG_COLOR.RESULT_SUMMARY)
    .setDescription(songs.map((s) => songLine(s, participantIds, nameOf)).join('\n'));
}

/**
 * "One public line per finished match, outside any thread." See
 * DESIGN.md's `PlayerNotificationPort`/`MatchChannelPort` design and the
 * Phase 4 plan's "byes excluded, forfeits/DQs worded as advancement" —
 * byes never reach this (no thread, no confirmation to trigger it), and a
 * forfeit/DQ/walkover has no real scoreline worth reporting.
 */
export function buildResultAnnouncement(
  bracket: BracketSide,
  round: number,
  outcome: MatchOutcome,
  points: Record<EntrantId, number>,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
): RenderedMessage {
  const winner = outcome.placements.find((p) => p.place === 1)!;
  const loser = outcome.placements.find((p) => p.entrantId !== winner.entrantId);
  const label = roundLabel(bracket, round);

  const isAdvancementOnly = outcome.by === 'FORFEIT' || outcome.by === 'DQ' || outcome.by === 'WALKOVER';
  const result = isAdvancementOnly
    ? `**${nameOf(winner.entrantId)}** advances`
    : `**${nameOf(winner.entrantId)}** defeats **${nameOf(loser!.entrantId)}** ${points[winner.entrantId] ?? 0}–${points[loser!.entrantId] ?? 0}`;

  return { content: `🏁 ${label} — ${result}` };
}
