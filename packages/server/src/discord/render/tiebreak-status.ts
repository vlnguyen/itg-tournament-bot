import type { EntrantId } from '../../domain/types.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * "The state message shows who has acted, never what they picked." See
 * DESIGN.md, "The tiebreak" — the one place a leak is a rules failure, not
 * an annoyance, so this deliberately takes only `choices`' *keys*, never
 * the chart index each one maps to.
 */
export function buildTiebreakStatusLines(
  choices: Partial<Record<EntrantId, number>>,
  participantIds: readonly EntrantId[],
  nameOf: NameLookup,
): string {
  return participantIds
    .map((id) => `**${nameOf(id)}** — ${choices[id] !== undefined ? '✅ picked' : '⬜ not yet'}`)
    .join('\n');
}
