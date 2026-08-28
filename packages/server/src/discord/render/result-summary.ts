import { EmbedBuilder } from 'discord.js';
import type { BracketSide } from '@itg/shared';
import type { EntrantId, MatchOutcome } from '../../domain/types.js';
import type { PublicMatch } from '../../domain/projection.js';
import { isAbsoluteWebUrl, matchUrl, tournamentUrl } from '../../web-url.js';
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

function songLabel(song: PublicMatch['songs'][number]): string {
  return song.tiebreakRound !== undefined ? `Tiebreak ${song.tiebreakRound}` : `Song ${song.index + 1}`;
}

function songOutcomeText(song: PublicMatch['songs'][number], nameOf: NameLookup): string {
  const result = song.result;
  if (!result) return '';
  if (result.winner === 'TIE') return 'tied';
  if (result.winner === 'VOID') return 'voided';
  return `${nameOf(result.winner)} wins`;
}

function songLine(song: PublicMatch['songs'][number], participantIds: readonly EntrantId[], nameOf: NameLookup): string {
  const scoreText = participantIds
    .filter((id) => song.ex[id] !== undefined)
    .map((id) => `${nameOf(id)} ${song.ex[id]!.toFixed(2)}%`)
    .join(' — ');
  const outcomeText = songOutcomeText(song, nameOf);
  const parts = [scoreText, outcomeText].filter((v) => v.length > 0).join(' — ');
  return `**${songLabel(song)}** — ${compactChartLabel(song.chart)}${parts ? `: ${parts}` : ''}`;
}

/** 🏆 winner / 🤝 tie reads faster across a whole event's worth of announcement lines than a "wins"/"tied" verb would. */
function announcementOutcomeText(song: PublicMatch['songs'][number], nameOf: NameLookup): string {
  const result = song.result;
  if (!result) return '';
  if (result.winner === 'TIE') return '🤝 Tie';
  if (result.winner === 'VOID') return 'voided';
  return `🏆 ${nameOf(result.winner)}`;
}

/**
 * The results-channel announcement's per-song line — chart and outcome
 * only, no EX%. The full scores already live one click away in the
 * thread's own result summary (`buildResultSummaryEmbed`); this is meant
 * to stay skimmable across a whole event's worth of matches. Still a
 * numbered list — `song.index` runs continuously across the whole set,
 * tiebreaks included — just without `songLine`'s "Song N" wording; a
 * tiebreak also gets its round called out, since that's a fact about the
 * match, not just a position in the list.
 */
function announcementSongLine(song: PublicMatch['songs'][number], nameOf: NameLookup): string {
  const outcomeText = announcementOutcomeText(song, nameOf);
  const chart = compactChartLabel(song.chart);
  const label = song.tiebreakRound !== undefined ? `Tiebreak ${song.tiebreakRound} — ${chart}` : chart;
  return `${song.index + 1}. **${label}**${outcomeText ? `: ${outcomeText}` : ''}`;
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

  // A forfeit or DQ is legal at any point before the match is DONE,
  // including before a single song has entered play — Protect/Veto still
  // in progress, or not even that far. `songs` is then empty, and
  // `EmbedBuilder.setDescription` rejects an empty string outright, so a
  // description is only ever built from a non-empty list.
  const description = songs.length > 0 ? songs.map((s) => songLine(s, participantIds, nameOf)).join('\n') : 'No songs were played.';

  return new EmbedBuilder()
    .setTitle(`Match complete — ${nameOf(winner.entrantId)} wins ${points[a] ?? 0}–${points[b] ?? 0}${decidedBy ? ` (${decidedBy})` : ''}`)
    .setColor(LOG_COLOR.RESULT_SUMMARY)
    .setDescription(description);
}

/**
 * One embed per finished match, outside any thread. See DESIGN.md's
 * `PlayerNotificationPort`/`MatchChannelPort` design and the Phase 4
 * plan's "byes excluded, forfeits/DQs worded as advancement" — byes never
 * reach this (no thread, no confirmation to trigger it). Worded as
 * advancement uniformly, whether the set was actually played out or ended
 * by ruling, forfeit, DQ or walkover: the score in parentheses is whatever
 * `points` holds either way — 0–0 for a match that never saw a song — so
 * the description never claims a scoreline that didn't happen while still
 * always naming who's through.
 *
 * The title is the whole embed's link target (`setURL`) — Discord embed
 * titles render as plain text with no inline markdown, so "round label,
 * then player vs player as a hyperlink" is one link covering the whole
 * title, not two spans with different treatment.
 */
export function buildResultAnnouncement(
  bracket: BracketSide,
  round: number,
  outcome: MatchOutcome,
  points: Record<EntrantId, number>,
  participantIds: readonly [EntrantId, EntrantId],
  nameOf: NameLookup,
  tournamentId: string,
  matchId: string,
  tournamentName: string,
  songs: PublicMatch['songs'],
): RenderedMessage {
  const winner = outcome.placements.find((p) => p.place === 1)!;
  const [a, b] = participantIds;
  const loserId = a === winner.entrantId ? b : a;
  const label = roundLabel(bracket, round);

  // Same wording either way a set can end: songs actually played (there
  // may be none — a forfeit/DQ before any song entered play).
  const songLines = songs.length > 0 ? songs.map((s) => announcementSongLine(s, nameOf)).join('\n') : null;

  const link = matchUrl(tournamentId, matchId);
  const embed = new EmbedBuilder()
    .setTitle(`${label} — ${nameOf(a)} vs ${nameOf(b)}`)
    .setColor(LOG_COLOR.RESULT_ANNOUNCEMENT)
    .setDescription(
      [
        `${nameOf(winner.entrantId)} advances (${points[winner.entrantId] ?? 0}-${points[loserId] ?? 0})`,
        ...(songLines ? ['', songLines] : []),
        '',
        `[${tournamentName}](${tournamentUrl(tournamentId)})`,
      ].join('\n'),
    );
  if (isAbsoluteWebUrl(link)) embed.setURL(link);

  return { embeds: [embed] };
}
