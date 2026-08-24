import { EmbedBuilder } from 'discord.js';
import type { EntrantId, MatchState } from '../../domain/types.js';
import { compactChartLabel } from './chart.js';
import { LOG_COLOR } from './draw.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * Posted once Protect/Veto finishes: the songs that will actually be
 * played, in the order they were protected — a vetoed chart is dropped
 * entirely, since it has no further bearing on the match. The Decider
 * (whichever chart neither player touched) is listed last, unattributed —
 * it belongs to the match, not to either player's picks.
 */
export function buildMatchSongsEmbed(
  state: Pick<MatchState, 'draw' | 'protects' | 'deciderIndex'>,
  nameOf: NameLookup,
): EmbedBuilder {
  const lines = state.protects.map((p) => `🛡️ **${nameOf(p.by)}** — ${compactChartLabel(state.draw[p.drawIndex]!)}`);
  if (state.deciderIndex !== undefined) {
    lines.push(`⭐ Decider — ${compactChartLabel(state.draw[state.deciderIndex]!)}`);
  }
  return new EmbedBuilder().setTitle('Match Songs').setColor(LOG_COLOR.DRAW).setDescription(lines.join('\n'));
}
