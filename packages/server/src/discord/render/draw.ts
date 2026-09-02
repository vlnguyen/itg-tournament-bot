import { EmbedBuilder } from 'discord.js';
import type { ChartSnapshot } from '@itg/shared';
import { fullChartDescription } from './chart.js';

/**
 * Distinguishes a message's *kind* at a glance when scrolling back — not
 * tied to match outcome. Shared by both in-thread log embeds and the
 * results-channel embeds (`render/result-summary.ts`'s
 * `buildResultAnnouncement`, `render/tournament-complete.ts`) — one place
 * for every embed accent color in the design.
 */
export const LOG_COLOR = {
  DRAW: 0x3498db,
  SONG_RESULT: 0x2ecc71,
  TIEBREAK: 0x9b59b6,
  RULING: 0xe67e22,
  /** A referee resetting Protect/Veto — a warning-toned action, same family as `RULING`/`AWAITING_REFEREE`/`TOURNAMENT_CANCELLED`. */
  RESET: 0xe67e22,
  RESULT_SUMMARY: 0xf1c40f,
  /** The per-match results-channel announcement. */
  RESULT_ANNOUNCEMENT: 0x2ecc71,
  /** The tournament-complete standings announcement — gold, distinct from the per-match green. */
  TOURNAMENT_COMPLETE: 0xffd700,
  /** Protect, and its permanent log line. The seed-choice ("Protect order") *log* line reuses this same green; its state-message prompt does not — see `PROTECT_ORDER` below. Also a static-pool format's player-driven song pick — same green, no separate color for it. */
  PROTECT: 0x2ecc71,
  /** Veto — the state-message prompt and its permanent log line. */
  VETO: 0xe74c3c,
  /** The seed-choice ("Protect order") state-message prompt — yellow, distinct from its own green log line. */
  PROTECT_ORDER: 0xf1c40f,
  /** A match/song escalated, awaiting a referee's ruling. */
  AWAITING_REFEREE: 0xe67e22,
  /** The in-thread note that the tournament was cancelled mid-match. */
  TOURNAMENT_CANCELLED: 0xe67e22,
  /** The thread's own "your match is ready" ping. */
  MATCH_READY: 0x3498db,
  /** The DM announcing check-in has opened. */
  TOURNAMENT_STARTING: 0x3498db,
  /** General channel — registration opened. */
  REGISTRATION_OPEN: 0x2ecc71,
  /** General channel — an entrant joined. */
  ENTRANT_JOINED: 0x2ecc71,
  /** General channel — an entrant checked in. */
  ENTRANT_CHECKED_IN: 0x3498db,
  /** General channel — the tournament was cancelled. Red, distinct from `TOURNAMENT_CANCELLED`'s orange in-thread note — this is the public-facing announcement, not an organizer-facing status line. */
  GENERAL_TOURNAMENT_CANCELLED: 0xe74c3c,
  /** General channel — check-in closed. Gray, distinct from cancellation's red — this is a routine phase change, not a bad outcome. */
  CHECKIN_CLOSED: 0x95a5a6,
  /** General channel — the tournament started. */
  TOURNAMENT_STARTED: 0x2ecc71,
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
