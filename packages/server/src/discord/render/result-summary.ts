import { EmbedBuilder } from 'discord.js';
import type { BracketShape, BracketSide } from '@itg/shared';
import { sectionLabel } from '@itg/shared';
import type { EntrantId, MatchOutcome, WinCondition } from '../../domain/types.js';
import type { PublicMatch } from '../../domain/projection.js';
import { isAbsoluteWebUrl, matchUrl, tournamentUrl } from '../../web-url.js';
import type { RenderedMessage } from '../ports.js';
import { compactChartLabel } from './chart.js';
import { LOG_COLOR } from './draw.js';

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

/**
 * Which agreement-level win condition actually settled it — `POINTS` reads
 * as the ordinary case (the score already says it) and gets no callout,
 * same as `DECIDED_BY.AGREEMENT`. `TIEBREAKER`/`AVG_EX` are the cases a
 * reader can't infer from the score alone, so those get named. See
 * `WinCondition`.
 */
const WIN_CONDITION_LABEL: Record<WinCondition, string> = {
  POINTS: '',
  TIEBREAKER: 'won by points, song pool exhausted',
  AVG_EX: 'won on average EX%',
};

/** `outcome.winCondition` is only ever set alongside `by === 'AGREEMENT'` — see `place()` in `protect-veto.ts`/`hubert.ts`. */
function decidedByText(outcome: MatchOutcome): string {
  if (outcome.winCondition) return WIN_CONDITION_LABEL[outcome.winCondition];
  return DECIDED_BY[outcome.by];
}

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

/** Mirrors `hubert.ts`'s own `averageEx` exactly — mean of every submitted EX% for `id`, across every song played — just computed from the wire-shape `songs` a Discord render has in hand, instead of `MatchState`. */
function averageEx(songs: PublicMatch['songs'], id: EntrantId): number {
  const values = songs.map((s) => s.ex[id]).filter((v): v is number => v !== undefined);
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Only meaningful once `winCondition === 'AVG_EX'` names it as what actually decided the set — everywhere else, the score already tells the story average EX% would just repeat. */
function averageExLine(songs: PublicMatch['songs'], participantIds: readonly EntrantId[], nameOf: NameLookup): string {
  return `Average EX%: ${participantIds.map((id) => `${nameOf(id)} ${averageEx(songs, id).toFixed(2)}%`).join(', ')}`;
}

function songLine(song: PublicMatch['songs'][number], participantIds: readonly EntrantId[], nameOf: NameLookup): string {
  const scoreText = participantIds
    .filter((id) => song.ex[id] !== undefined)
    .map((id) => `${nameOf(id)} ${song.ex[id]!.toFixed(2)}%`)
    .join(', ');
  const outcomeText = songOutcomeText(song, nameOf);
  const parts = [scoreText, outcomeText].filter((v) => v.length > 0).join('; ');
  return `**${songLabel(song)}** (${compactChartLabel(song.chart)})${parts ? `: ${parts}` : ''}`;
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
  // `compactChartLabel` already bolds the pool label itself for a labeled
  // chart (Hubert's formats) — wrapping that in a second `**...**` here
  // nests markers Discord can't parse, showing literal asterisks instead
  // of bold text. Only add the wrapper when there's nothing bold yet.
  const emphasized = song.chart.poolLabel ? chart : `**${chart}**`;
  const label = song.tiebreakRound !== undefined ? `**Tiebreak ${song.tiebreakRound}** (${emphasized})` : emphasized;
  return `${song.index + 1}. ${label}${outcomeText ? `: ${outcomeText}` : ''}`;
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
  const decidedBy = decidedByText(outcome);

  // A forfeit or DQ is legal at any point before the match is DONE,
  // including before a single song has entered play — Protect/Veto still
  // in progress, or not even that far. `songs` is then empty, and
  // `EmbedBuilder.setDescription` rejects an empty string outright, so a
  // description is only ever built from a non-empty list.
  const description =
    songs.length > 0
      ? [
          songs.map((s) => songLine(s, participantIds, nameOf)).join('\n'),
          ...(outcome.winCondition === 'AVG_EX' ? ['', averageExLine(songs, participantIds, nameOf)] : []),
        ].join('\n')
      : 'No songs played.';

  return new EmbedBuilder()
    .setTitle(`Match complete: ${nameOf(winner.entrantId)} wins ${points[a] ?? 0}–${points[b] ?? 0}${decidedBy ? ` (${decidedBy})` : ''}`)
    .setColor(LOG_COLOR.RESULT_SUMMARY)
    .setDescription(description);
}

/**
 * One embed per finished match, outside any thread. See DESIGN.md's
 * `PlayerNotificationPort`/`MatchChannelPort` design and the Phase 4
 * plan's "byes excluded" — byes never reach this (no thread, no
 * confirmation to trigger it). The score in parentheses is whatever
 * `points` holds either way — 0–0 for a match that never saw a song — so
 * the description never claims a scoreline that didn't happen while still
 * always naming who won.
 *
 * **Wording branches on two things:**
 * - `tournamentComplete` — "advances" has nowhere left to point once this
 *   was the match that decided the whole tournament (the Grand Final's
 *   actual last game, whichever round that turned out to be — see the
 *   caller's own `grandFinalNeedsReset`-driven check). That match instead
 *   reads "wins", plain.
 * - How the set was actually decided — `decidedByText(outcome)`, the same
 *   helper `buildResultSummaryEmbed`'s title uses, so a ruling/forfeit/DQ/
 *   walkover (or a Hubert-format tiebreaker/avg-EX% finish) is called out
 *   here too, not just in the match's own thread.
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
  shape?: BracketShape,
  tournamentComplete = false,
): RenderedMessage {
  const winner = outcome.placements.find((p) => p.place === 1)!;
  const [a, b] = participantIds;
  const loserId = a === winner.entrantId ? b : a;
  const label = sectionLabel(bracket, round, shape);
  const decidedBy = decidedByText(outcome);
  const verb = tournamentComplete ? 'wins' : 'advances';

  // Same wording either way a set can end: songs actually played (there
  // may be none — a forfeit/DQ before any song entered play).
  const songLines = songs.length > 0 ? songs.map((s) => announcementSongLine(s, nameOf)).join('\n') : null;

  const link = matchUrl(tournamentId, matchId);
  const embed = new EmbedBuilder()
    .setTitle(`${label}: ${nameOf(a)} vs ${nameOf(b)}`)
    .setColor(LOG_COLOR.RESULT_ANNOUNCEMENT)
    .setDescription(
      [
        `${nameOf(winner.entrantId)} ${verb} (${points[winner.entrantId] ?? 0}-${points[loserId] ?? 0})${decidedBy ? ` — ${decidedBy}` : ''}`,
        ...(songLines ? ['', songLines] : []),
        '',
        `[${tournamentName}](${tournamentUrl(tournamentId)})`,
      ].join('\n'),
    );
  if (isAbsoluteWebUrl(link)) embed.setURL(link);

  return { embeds: [embed] };
}
