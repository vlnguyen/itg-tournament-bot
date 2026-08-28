import type { BotDirective, MatchFormat, MatchState } from './types.js';
import { emptyState } from './types.js';
import { makeProtectVetoFormat, opponentOf, playedDrawIndices } from './protect-veto.js';

export const DRAW_SIZE = 7;
export const TIEBREAK_SIZE = 3;
export const POINTS_TO_WIN = 3;

/** ABBAAB. A is whoever took the first Protect. */
const SEQUENCE = [
  { who: 'A', action: 'PROTECT' },
  { who: 'B', action: 'PROTECT' },
  { who: 'B', action: 'VETO' },
  { who: 'A', action: 'VETO' },
  { who: 'A', action: 'PROTECT' },
  { who: 'B', action: 'PROTECT' },
] as const;

// ---------------------------------------------------------------------------
// Play order — fully determined, so the bot advances the set unattended.
// ---------------------------------------------------------------------------

function nextDrawSong(s: MatchState): BotDirective | undefined {
  const played = playedDrawIndices(s);
  const protectsInOrder = s.protects.map((p) => p.drawIndex);
  const unplayedProtects = protectsInOrder.filter((i) => !played.has(i));
  const deciderUnplayed = s.deciderIndex !== undefined && !played.has(s.deciderIndex);

  if (s.songs.length === 0) {
    const first = protectsInOrder[0];
    if (first === undefined) return undefined;
    return { do: 'START_SONG', source: 'FIRST_PROTECT', drawIndex: first };
  }

  const last = s.songs[s.songs.length - 1]!;
  if (!last.result) return undefined;
  const winner = last.result.winner;

  // A tie leaves no loser, so nobody's preference applies: protect order does,
  // falling through to the Decider. This is genuinely distinct from the loser
  // rule — if A loses song 1 (A1), the loser rule gives A2 while protect order
  // gives B1.
  if (winner === 'TIE' || winner === 'VOID') {
    if (unplayedProtects.length > 0) {
      return { do: 'START_SONG', source: 'PROTECT_ORDER', drawIndex: unplayedProtects[0]! };
    }
    if (deciderUnplayed) {
      return { do: 'START_SONG', source: 'DECIDER', drawIndex: s.deciderIndex! };
    }
    return undefined;
  }

  const loser = opponentOf(s, winner);
  const ownUnplayed = s.protects.filter((p) => p.by === loser && !played.has(p.drawIndex));
  if (ownUnplayed.length > 0) {
    return { do: 'START_SONG', source: 'LOSER_PROTECT', drawIndex: ownUnplayed[0]!.drawIndex };
  }
  if (deciderUnplayed) {
    return { do: 'START_SONG', source: 'DECIDER', drawIndex: s.deciderIndex! };
  }
  // Necessarily the opponent's protect — the choice is forced, so the bot plays
  // it rather than prompting. See the uniqueness property test.
  if (unplayedProtects.length > 0) {
    return { do: 'START_SONG', source: 'FORCED', drawIndex: unplayedProtects[0]! };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

export const Bo5ProtectVetoFormat: MatchFormat = makeProtectVetoFormat({
  key: 'bo5-protect-veto',
  drawSize: DRAW_SIZE,
  tiebreakSize: TIEBREAK_SIZE,
  pointsToWin: POINTS_TO_WIN,
  sequence: SEQUENCE,
  nextDrawSong,
});

export { emptyState };
