import type { ChartSnapshot } from '@itg/shared';
import type { EntrantId } from '../domain/types.js';
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
