import type { EntrantId, MatchState } from '../../domain/types.js';
import { titleWithSubtitle } from './chart.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * "Someone scrolling back can reconstruct the match without opening the
 * web app" (DESIGN.md, "Two kinds of bot message") is what the permanent
 * Draw log message is for, but Protect/Veto itself leaves no trace there —
 * DESIGN.md keeps the Draw message posted once and never edited. This is
 * the compromise: a status line per chart, rebuilt fresh into the
 * *disposable* state-message embed on every step, so progress is visible
 * without ever touching the permanent record.
 */
export function buildDrawStatusLines(
  state: Pick<MatchState, 'draw' | 'protects' | 'vetoes' | 'deciderIndex'>,
  nameOf: NameLookup,
): string {
  return state.draw
    .map((chart, i) => {
      const label = titleWithSubtitle(chart) + (chart.flags.includes('noCmod') ? ' ⚠️' : '');
      const vetoedBy = state.vetoes.find((v) => v.drawIndex === i)?.by;
      if (vetoedBy) return `${i + 1}. ~~${label}~~ ❌ Vetoed by ${nameOf(vetoedBy)}`;
      const protectedBy = state.protects.find((p) => p.drawIndex === i)?.by;
      if (protectedBy) return `${i + 1}. ${label} 🛡️ Protected by ${nameOf(protectedBy)}`;
      if (state.deciderIndex === i) return `${i + 1}. ${label} ⭐ Decider`;
      return `${i + 1}. ${label}`;
    })
    .join('\n');
}
