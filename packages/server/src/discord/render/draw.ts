import { EmbedBuilder } from 'discord.js';
import type { ChartSnapshot } from '@itg/shared';
import { fullChartDescription } from './chart.js';

/** Distinguishes a log message's *kind* at a glance when scrolling back — not tied to match outcome. */
export const LOG_COLOR = {
  DRAW: 0x3498db,
  SONG_RESULT: 0x2ecc71,
  TIEBREAK: 0x9b59b6,
  RULING: 0xe67e22,
  RESET: 0x95a5a6,
  RESULT_SUMMARY: 0xf1c40f,
} as const;

/**
 * "The Draw posts as an embed — seven charts in full form, numbered."
 * Posted once as a log message; never edited. See DESIGN.md, "The Draw
 * and Protect/Veto".
 */
export function buildDrawEmbed(charts: ChartSnapshot[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('The Draw').setColor(LOG_COLOR.DRAW);
  charts.forEach((chart, i) => {
    embed.addFields({ name: `${i + 1}`, value: fullChartDescription(chart) });
  });
  return embed;
}
