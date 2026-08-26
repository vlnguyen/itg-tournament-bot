import { generateBracket, matchKey } from '@itg/shared';
import type { TournamentSnapshot } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { buildBracketLayout } from './bracket-layout.js';

/** Every generated match, given a placeholder PENDING projection — enough to exercise the layout, not the live-state narrowing. */
function fullSnapshot(entrantCount: number): TournamentSnapshot {
  const generated = generateBracket(entrantCount);
  return {
    id: 't1',
    name: 'Test',
    state: 'RUNNING',
    entrantCount,
    matches: generated.matches.map((gm, i) => ({
      id: `m${i}`,
      bracket: gm.ref.bracket,
      round: gm.ref.round,
      slot: gm.ref.slot,
      match: {
        seq: 0,
        participants: [],
        status: 'PENDING',
        awaitingTo: false,
        outcomeBy: null,
        points: {},
        currentChartId: null,
        winnerId: null,
      },
    })),
  };
}

describe.each([2, 3, 4, 5, 8, 9])('buildBracketLayout, %i entrants', (entrantCount) => {
  it('places every generated match into exactly one of: winners columns, losers columns, grand final, grand final reset', () => {
    const layout = buildBracketLayout(fullSnapshot(entrantCount));
    const placed = new Set<string>();
    for (const col of [...layout.winnersColumns, ...layout.losersColumns]) {
      for (const m of col.matches) placed.add(matchKey({ bracket: m.bracket, round: m.round, slot: m.slot }));
    }
    if (layout.grandFinal) placed.add(matchKey({ bracket: layout.grandFinal.bracket, round: layout.grandFinal.round, slot: layout.grandFinal.slot }));
    if (layout.grandFinalReset) {
      placed.add(matchKey({ bracket: layout.grandFinalReset.bracket, round: layout.grandFinalReset.round, slot: layout.grandFinalReset.slot }));
    }

    const generated = generateBracket(entrantCount);
    expect(placed.size).toBe(generated.matches.length);
    for (const gm of generated.matches) expect(placed.has(matchKey(gm.ref))).toBe(true);
  });

  it('columns are ordered by round, and each round is ordered by slot', () => {
    const layout = buildBracketLayout(fullSnapshot(entrantCount));
    for (const columns of [layout.winnersColumns, layout.losersColumns]) {
      columns.forEach((col, i) => expect(col.round).toBe(i + 1));
      for (const col of columns) {
        const slots = col.matches.map((m) => m.slot);
        expect(slots).toEqual([...slots].sort((a, b) => a - b));
      }
    }
  });

  it('grand final exists iff there are more than two entrants', () => {
    const layout = buildBracketLayout(fullSnapshot(entrantCount));
    if (entrantCount === 2) {
      expect(layout.grandFinal).toBeNull();
      expect(layout.grandFinalReset).toBeNull();
    } else {
      expect(layout.grandFinal).not.toBeNull();
      expect(layout.grandFinalReset).not.toBeNull();
    }
  });

  it('advancement is exactly the inverse of every WINNER_OF/LOSER_OF source', () => {
    const layout = buildBracketLayout(fullSnapshot(entrantCount));
    const generated = generateBracket(entrantCount);
    for (const gm of generated.matches) {
      for (const source of gm.sources) {
        if (source.kind !== 'WINNER_OF' && source.kind !== 'LOSER_OF') continue;
        const entry = layout.advancement.get(matchKey(source.match));
        expect(entry).toBeDefined();
        const goesTo = source.kind === 'WINNER_OF' ? entry!.winnerGoesTo : entry!.loserGoesTo;
        expect(goesTo).toContainEqual(gm.ref);
      }
    }
  });

  it('the grand final and its reset share sources — both rows appear as destinations of the same finalists', () => {
    const layout = buildBracketLayout(fullSnapshot(entrantCount));
    if (entrantCount === 2) return; // no grand final at all in the two-entrant case
    const generated = generateBracket(entrantCount);
    const winnersFinal = generated.matches.find((m) => m.ref.bracket === 'WINNERS' && m.ref.round === layout.winnersColumns.length)!;
    const entry = layout.advancement.get(matchKey(winnersFinal.ref))!;
    expect(entry.winnerGoesTo).toHaveLength(2);
    expect(entry.winnerGoesTo).toContainEqual({ bracket: 'GRAND_FINAL', round: 1, slot: 0 });
    expect(entry.winnerGoesTo).toContainEqual({ bracket: 'GRAND_FINAL', round: 2, slot: 0 });
  });
});
