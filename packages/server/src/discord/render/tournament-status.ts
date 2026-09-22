import { EmbedBuilder } from 'discord.js';
import { LOG_COLOR } from './draw.js';
import type { RenderedMessage } from '../ports.js';

const BRACKET_LABEL: Record<string, string> = {
  WINNERS: 'Winners',
  LOSERS: 'Losers',
  GRAND_FINAL: 'Grand Final',
};
const BRACKET_ORDER: Record<string, number> = { WINNERS: 0, LOSERS: 1, GRAND_FINAL: 2 };

export interface MatchStatusCount {
  bracket: string;
  round: number;
  status: string;
}

/**
 * The Tournament Status message's content — a round-by-round
 * PENDING/IN_PROGRESS/COMPLETE tally, posted once when the tournament
 * starts and refreshed on every match completion. See DESIGN.md,
 * "Notifying players, and the channels" — the one deliberate exception to
 * the matches channel otherwise carrying no bot messages in its body.
 */
export function buildTournamentStatusMessage(tournamentName: string, matches: readonly MatchStatusCount[]): RenderedMessage {
  const groups = new Map<string, { bracket: string; round: number; pending: number; inProgress: number; complete: number }>();
  for (const m of matches) {
    const key = `${m.bracket}:${m.round}`;
    const g = groups.get(key) ?? { bracket: m.bracket, round: m.round, pending: 0, inProgress: 0, complete: 0 };
    if (m.status === 'PENDING') g.pending++;
    else if (m.status === 'IN_PROGRESS') g.inProgress++;
    else if (m.status === 'COMPLETE') g.complete++;
    groups.set(key, g);
  }

  const lines = [...groups.values()]
    .sort((a, b) => (BRACKET_ORDER[a.bracket] ?? 99) - (BRACKET_ORDER[b.bracket] ?? 99) || a.round - b.round)
    .map((g) => {
      const parts: string[] = [];
      if (g.complete > 0) parts.push(`${g.complete} complete`);
      if (g.inProgress > 0) parts.push(`${g.inProgress} in progress`);
      if (g.pending > 0) parts.push(`${g.pending} pending`);
      const label = g.bracket === 'GRAND_FINAL' ? BRACKET_LABEL[g.bracket] : `${BRACKET_LABEL[g.bracket] ?? g.bracket} Round ${g.round}`;
      return `**${label}**: ${parts.join(', ') || 'no matches'}`;
    });

  const description = lines.length > 0 ? lines.join('\n') : 'No matches yet.';
  return {
    embeds: [new EmbedBuilder().setTitle(`Tournament Status: ${tournamentName}`).setColor(LOG_COLOR.TOURNAMENT_STARTED).setDescription(description)],
  };
}
