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
/**
 * `picks` is optional — only a static-pool format (Hubert's formats) ever
 * populates it, so a Bo3/Bo5 call site never needs to pass it.
 */
export function buildDrawStatusLines(
  state: Pick<MatchState, 'draw' | 'protects' | 'vetoes' | 'deciderIndex'> & { picks?: MatchState['picks'] },
  nameOf: NameLookup,
): string {
  return state.draw
    .map((chart, i) => {
      // A specific song always gets its shorthand label (RD1, FT2, ...),
      // never the spelled-out category — see the plan's naming rule.
      const prefix = chart.poolLabel ? `**${chart.poolLabel}** ` : '';
      const label = prefix + titleWithSubtitle(chart) + (chart.flags.includes('noCmod') ? ' ⚠️' : '');
      const vetoedBy = state.vetoes.find((v) => v.drawIndex === i)?.by;
      if (vetoedBy) return `${i + 1}. ~~${label}~~ ❌ Vetoed by ${nameOf(vetoedBy)}`;
      const protectedBy = state.protects.find((p) => p.drawIndex === i)?.by;
      if (protectedBy) return `${i + 1}. ${label} 🛡️ Protected by ${nameOf(protectedBy)}`;
      const pickedBy = state.picks?.find((p) => p.drawIndex === i)?.by;
      if (pickedBy) return `${i + 1}. ${label} 🎵 Picked by ${nameOf(pickedBy)}`;
      if (state.deciderIndex === i) return `${i + 1}. ${label} ⭐ Decider`;
      if (chart.poolLabel === 'TB') return `${i + 1}. ${label} 🔒 Reserved for the Tiebreaker`;
      return `${i + 1}. ${label}`;
    })
    .join('\n');
}
