import type { BotDirective, MatchFormat, MatchState } from './types.js';
import { makeProtectVetoFormat } from './protect-veto.js';

export const DRAW_SIZE = 5;
export const TIEBREAK_SIZE = 3;
export const POINTS_TO_WIN = 2;

/**
 * Protect, Protect, Veto, Veto. Protects go to role A then B — whoever took
 * the first Protect is A, same convention as Bo5. Vetoes go by seed instead
 * of role: the higher seed automatically holds 1st Veto and the lower seed
 * 2nd — the counterpart to the higher seed's own choice between 1st and 2nd
 * Protect.
 */
const SEQUENCE = [
  { who: 'A', action: 'PROTECT' },
  { who: 'B', action: 'PROTECT' },
  { who: 'HIGHER_SEED', action: 'VETO' },
  { who: 'LOWER_SEED', action: 'VETO' },
] as const;

// ---------------------------------------------------------------------------
// Play order — fixed, unlike Bo5's loser-preference rule: 1st Protect, then
// 2nd Protect, then the Decider, regardless of who won each song.
// ---------------------------------------------------------------------------

function nextDrawSong(s: MatchState): BotDirective | undefined {
  const protectsInOrder = s.protects.map((p) => p.drawIndex);
  switch (s.songs.length) {
    case 0: {
      const first = protectsInOrder[0];
      return first === undefined ? undefined : { do: 'START_SONG', source: 'FIRST_PROTECT', drawIndex: first };
    }
    case 1: {
      const second = protectsInOrder[1];
      return second === undefined
        ? undefined
        : { do: 'START_SONG', source: 'PROTECT_ORDER', drawIndex: second };
    }
    case 2:
      return s.deciderIndex === undefined
        ? undefined
        : { do: 'START_SONG', source: 'DECIDER', drawIndex: s.deciderIndex };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

export const Bo3ProtectVetoFormat: MatchFormat = makeProtectVetoFormat({
  key: 'bo3-protect-veto',
  drawSize: DRAW_SIZE,
  tiebreakSize: TIEBREAK_SIZE,
  pointsToWin: POINTS_TO_WIN,
  sequence: SEQUENCE,
  nextDrawSong,
});

/** Same ruleset, minus the separate `CONFIRM_RESULT` step — see `protect-veto.ts`'s `autoComplete`. */
export const Bo3ProtectVetoFormatV2: MatchFormat = makeProtectVetoFormat({
  key: 'bo3-protect-veto-v2',
  drawSize: DRAW_SIZE,
  tiebreakSize: TIEBREAK_SIZE,
  pointsToWin: POINTS_TO_WIN,
  sequence: SEQUENCE,
  nextDrawSong,
  autoComplete: true,
});
