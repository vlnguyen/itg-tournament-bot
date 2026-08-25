import type { ChartSnapshot } from '@itg/shared';
import type { EntrantId, TiebreakRound } from '../domain/types.js';
import type { RenderedMessage } from './ports.js';
import { compactChartLabel } from './render/chart.js';
import { displayName, type PlayerDirectory } from './state-message.js';

/**
 * "Someone scrolling back can reconstruct the match without opening the
 * web app" — each Protect/Veto action gets a permanent line of its own,
 * not just the disposable state message's draw-status field, so the
 * *sequence* survives once the state message has moved on to something
 * else entirely.
 */
export function renderProtectVetoLog(
  kind: 'PROTECT' | 'VETO',
  actorId: EntrantId,
  chart: ChartSnapshot,
  players: PlayerDirectory,
): RenderedMessage {
  const verb = kind === 'PROTECT' ? 'protects' : 'vetoes';
  const emoji = kind === 'PROTECT' ? '🛡️' : '🚫';
  return { content: `${emoji} **${displayName(players, actorId)}** ${verb} ${compactChartLabel(chart)}` };
}

export function renderSeedChoiceLog(
  actorId: EntrantId,
  order: 'FIRST' | 'SECOND',
  players: PlayerDirectory,
): RenderedMessage {
  const choice = order === 'FIRST' ? 'to Protect first' : 'to let their opponent Protect first';
  return { content: `🪙 **${displayName(players, actorId)}** chooses ${choice}` };
}

/** A song committed by player agreement — "each committed song result" from DESIGN.md's log-message list. */
export function renderSongResultLog(
  songIndex: number,
  chart: ChartSnapshot,
  winner: EntrantId | 'TIE' | 'VOID',
  players: PlayerDirectory,
): RenderedMessage {
  const label = `Song ${songIndex + 1} (${compactChartLabel(chart)})`;
  if (winner === 'TIE') return { content: `🤝 ${label} tied — no points awarded.` };
  if (winner === 'VOID') return { content: `🚫 ${label} voided.` };
  return { content: `🏆 **${displayName(players, winner)}** wins ${label}` };
}

/**
 * "A ruling posts to the thread as a log message, carrying the outcome...
 * and the referee's name." Distinct from `renderSongResultLog` — a ruling
 * is never rendered generically off `SONG_COMMITTED`, since only the
 * caller handling the ruling interaction has the referee's identity to
 * attribute it to.
 */
export function renderRulingLog(
  songIndex: number,
  chart: ChartSnapshot,
  result: EntrantId | 'TIE' | 'VOID',
  refereeDisplayName: string,
  players: PlayerDirectory,
): RenderedMessage {
  const outcome =
    result === 'VOID' ? 'voided' : result === 'TIE' ? 'ruled a tie' : `awarded to **${displayName(players, result)}**`;
  return {
    content: `⚖️ Song ${songIndex + 1} (${compactChartLabel(chart)}) ${outcome} — ruling by **${refereeDisplayName}**`,
  };
}

/**
 * "The reveal is a log message, posted once both picks exist: both
 * selections, the rule applied... and the chart that results." See
 * DESIGN.md, "The tiebreak" — permanent, because by then it's history and
 * the whole point of the mechanism is that it can be audited afterwards.
 */
export function renderTiebreakRevealLog(
  round: TiebreakRound,
  participantIds: readonly [EntrantId, EntrantId],
  players: PlayerDirectory,
): RenderedMessage {
  const [a, b] = participantIds;
  const pickA = round.charts[round.choices[a]!]!;
  const pickB = round.charts[round.choices[b]!]!;
  const resultChart = round.charts[round.resolvedIndex!]!;
  const rule =
    round.choices[a] === round.choices[b]
      ? `Both picked the same chart — it plays: ${compactChartLabel(resultChart)}`
      : `Different picks — the unselected chart plays: ${compactChartLabel(resultChart)}`;

  return {
    content: [
      `🎲 Tiebreak round ${round.round} — picks revealed`,
      `**${displayName(players, a)}** chose ${compactChartLabel(pickA)}`,
      `**${displayName(players, b)}** chose ${compactChartLabel(pickB)}`,
      rule,
    ].join('\n'),
  };
}

/**
 * "A log message records that a referee reset the sequence and that the
 * Draw stands." See DESIGN.md, "Resetting Protect/Veto" — the abandoned
 * picks stay in the log above this line; nothing is removed, only
 * cleared going forward.
 */
export function renderResetLog(refereeDisplayName: string): RenderedMessage {
  return { content: `🔄 **${refereeDisplayName}** reset the Protect/Veto sequence. The Draw stands.` };
}
