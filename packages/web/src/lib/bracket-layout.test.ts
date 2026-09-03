import { generateBracket, matchKey } from '@itg/shared';
import type { Roster, RosterEntrant, TournamentSnapshot } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { buildBracketLayout, projectRoundOne } from './bracket-layout.js';

/** Every generated match, given a placeholder PENDING projection — enough to exercise the layout, not the live-state narrowing. */
function fullSnapshot(entrantCount: number): TournamentSnapshot {
  const generated = generateBracket(entrantCount);
  return {
    id: 't1',
    name: 'Test',
    state: 'RUNNING',
    guildId: 'g1',
    guildName: 'Test Guild',
    entrantCount,
    matches: generated.matches.map((gm, i) => ({
      id: `m${i}`,
      bracket: gm.ref.bracket,
      round: gm.ref.round,
      slot: gm.ref.slot,
      match: {
        seq: 0,
        formatKey: 'bo5-protect-veto',
        participants: [],
        status: 'PENDING',
        awaitingTo: false,
        outcomeBy: null,
        outcomeWinCondition: null,
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

function rosterEntrant(seed: number): RosterEntrant {
  return { entrantId: `e${seed}`, discordUserId: `d${seed}`, displayName: `Player ${seed}`, checkedIn: true, seed, joinedAt: '2026-01-01T00:00:00.000Z' };
}

describe('projectRoundOne', () => {
  it('projects a full round of real seeds when entrantCount is already a power of two — no byes at all', () => {
    const generated = generateBracket(4);
    const roster: Roster = [1, 2, 3, 4].map(rosterEntrant);
    const projections = projectRoundOne(generated, roster);

    expect(projections.get(matchKey({ bracket: 'WINNERS', round: 1, slot: 0 }))).toEqual([
      { kind: 'entrant', seed: 1, displayName: 'Player 1' },
      { kind: 'entrant', seed: 4, displayName: 'Player 4' },
    ]);
    expect(projections.get(matchKey({ bracket: 'WINNERS', round: 1, slot: 1 }))).toEqual([
      { kind: 'entrant', seed: 2, displayName: 'Player 2' },
      { kind: 'entrant', seed: 3, displayName: 'Player 3' },
    ]);
  });

  it('projects a bye slot as { kind: "bye" } rather than a missing entrant', () => {
    // 5 entrants pads to size 8; seedOrder(8) puts seed 8 opposite seed 1 —
    // the top seed's round-1 opponent is always the deepest bye.
    const generated = generateBracket(5);
    const roster: Roster = [1, 2, 3, 4, 5].map(rosterEntrant);
    const projections = projectRoundOne(generated, roster);

    const topSeedMatch = generated.matches.find((m) => m.ref.bracket === 'WINNERS' && m.ref.round === 1 && m.sources.some((s) => s.kind === 'SEED' && s.seed === 1))!;
    expect(projections.get(matchKey(topSeedMatch.ref))).toEqual([{ kind: 'entrant', seed: 1, displayName: 'Player 1' }, { kind: 'bye' }]);
  });

  it('falls back to undefined for a seed the current roster no longer has — a stale bracket', () => {
    const generated = generateBracket(4);
    const roster: Roster = [1, 2, 3].map(rosterEntrant); // seed 4 is gone
    const projections = projectRoundOne(generated, roster);
    expect(projections.get(matchKey({ bracket: 'WINNERS', round: 1, slot: 0 }))).toEqual([{ kind: 'entrant', seed: 1, displayName: 'Player 1' }, undefined]);
  });

  it('only covers round 1 — no entries for round 2 or the grand final', () => {
    const generated = generateBracket(4);
    const roster: Roster = [1, 2, 3, 4].map(rosterEntrant);
    const projections = projectRoundOne(generated, roster);
    expect(projections.has(matchKey({ bracket: 'WINNERS', round: 2, slot: 0 }))).toBe(false);
    expect(projections.has(matchKey({ bracket: 'GRAND_FINAL', round: 1, slot: 0 }))).toBe(false);
  });

  it('skips a not-checked-in entrant and renumbers around the gap, matching what renormalizeSeeds will do at start', () => {
    // Roster arrives sorted by (seed asc, joinedAt asc), same as `getRoster`
    // server-side. Seed 2 never checked in, so a 3-checked-in bracket's
    // dense seeds are 1 -> roster seed 1, 2 -> roster seed 3, 3 -> roster seed 4.
    const generated = generateBracket(3);
    const roster: Roster = [rosterEntrant(1), { ...rosterEntrant(2), checkedIn: false }, rosterEntrant(3), rosterEntrant(4)];
    const projections = projectRoundOne(generated, roster);

    const bySlot = (slot: number) => projections.get(matchKey({ bracket: 'WINNERS', round: 1, slot }))!;
    // seedOrder(4) = [1, 4, 2, 3] pairing dense seeds (1,4) and (2,3); dense
    // seed 4 is a bye since only 3 are checked in.
    expect(bySlot(0)).toEqual([{ kind: 'entrant', seed: 1, displayName: 'Player 1' }, { kind: 'bye' }]);
    expect(bySlot(1)).toEqual([{ kind: 'entrant', seed: 2, displayName: 'Player 3' }, { kind: 'entrant', seed: 3, displayName: 'Player 4' }]);
  });

  it('re-pairs round 1 purely from the roster passed in — the live "update as seeds move" contract', () => {
    const generated = generateBracket(4);
    const before = projectRoundOne(generated, [1, 2, 3, 4].map(rosterEntrant));
    // Swap seeds 1 and 2 — as if a TO dragged seed 2 to the top. `roster`
    // always arrives pre-sorted by seed (see `getRoster`), so the swapped
    // entrant leads the array too.
    const swapped: Roster = [{ ...rosterEntrant(2), seed: 1 }, { ...rosterEntrant(1), seed: 2 }, rosterEntrant(3), rosterEntrant(4)];
    const after = projectRoundOne(generated, swapped);

    expect(before.get(matchKey({ bracket: 'WINNERS', round: 1, slot: 0 }))![0]).toEqual({ kind: 'entrant', seed: 1, displayName: 'Player 1' });
    expect(after.get(matchKey({ bracket: 'WINNERS', round: 1, slot: 0 }))![0]).toEqual({ kind: 'entrant', seed: 1, displayName: 'Player 2' });
  });
});
