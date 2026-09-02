import { poolCategoryOf } from '@itg/shared';
import { activeSong, computePoints, idsOf, opponentOf } from './protect-veto.js';
import type {
  DomainEffect,
  EntrantId,
  EscalationReason,
  MatchEvent,
  MatchFormat,
  MatchOutcome,
  MatchState,
} from './types.js';

/**
 * Hubert's formats (HB-11, HB-13) — see NEW_FORMAT.md. Unlike Bo3/Bo5, this
 * implements `MatchFormat` directly rather than through
 * `makeProtectVetoFormat`, per DESIGN.md's "Match Format as a Plugin": the
 * Draw is a fixed, TO-labeled pool rather than a random sample, vetoes are
 * category-restricted, song selection is a player pick rather than an
 * algorithmic `nextDrawSong`, and the endgame is score-triggered rather
 * than draw-exhaustion-triggered. `activeSong`/`computePoints`/`idsOf`/
 * `opponentOf` are reused from `protect-veto.ts` — the one part of the
 * per-song play loop (scoring, winner selection) that genuinely is the same
 * regardless of how a format decides what plays.
 */

const POINTS_TO_WIN = 3;

export interface HubertConfig {
  readonly key: string;
  /** 11 or 13 — the exact size of the labeled pool this format requires. */
  readonly drawSize: number;
  /** Who vetoes at each step, in order. `['A','B']` for HB-11, `['A','B','A','B']` for HB-13. */
  readonly vetoSequence: readonly ('A' | 'B')[];
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/** The one Draw position reserved for the forced Tiebreaker song — never a normal veto/pick choice. */
function tbIndex(s: MatchState): number {
  return s.draw.findIndex((c) => c.poolLabel === 'TB');
}

function usedIndices(s: MatchState): Set<number> {
  return new Set([...s.vetoes, ...s.picks].map((x) => x.drawIndex));
}

/** Every Draw position still eligible for a veto or a pick — the reserved TB position excluded. */
function availableNonTbIndices(s: MatchState): number[] {
  const used = usedIndices(s);
  const tb = tbIndex(s);
  return s.draw.map((_, i) => i).filter((i) => i !== tb && !used.has(i));
}

/**
 * A player may not veto two songs from the same category (HB-13; vacuous
 * for HB-11, where each player only ever vetoes once). Every Draw position
 * here is guaranteed labeled — `DRAW_STATIC` only ever loads a tournament's
 * `ChartLabel` rows, never an unlabeled chart.
 */
function vetoChoicesFor(s: MatchState, actor: EntrantId): number[] {
  const usedCategories = new Set(
    s.vetoes.filter((v) => v.by === actor).map((v) => poolCategoryOf(s.draw[v.drawIndex]!.poolLabel!)),
  );
  return availableNonTbIndices(s).filter((i) => !usedCategories.has(poolCategoryOf(s.draw[i]!.poolLabel!)));
}

/** "Player B selects the first song to play, then song picks alternate players from there." */
function nextPickActor(s: MatchState): EntrantId {
  return s.picks.length % 2 === 0 ? s.b! : s.a!;
}

function averageEx(s: MatchState, id: EntrantId): number {
  const values = s.songs.map((song) => song.ex[id]).filter((v): v is number => v !== undefined);
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** True once the forced Tiebreaker song has committed a result — by construction, always the last song a match plays. */
function matchOver(s: MatchState): boolean {
  const idx = tbIndex(s);
  return idx !== -1 && s.songs.some((song) => song.drawIndex === idx && !!song.result);
}

/** The score reached 2-2, or the non-TB pool has run out (from ties) — either way the TB song is forced next. */
function needsForcedTiebreaker(s: MatchState): boolean {
  if (matchOver(s)) return false;
  const [x, y] = idsOf(s);
  if ((s.points[x!] ?? 0) === 2 && (s.points[y!] ?? 0) === 2) return true;
  return availableNonTbIndices(s).length === 0;
}

/**
 * The unified endgame rule: first to {@link POINTS_TO_WIN} wins outright;
 * otherwise, once nothing is left to play (the forced TB song has
 * committed), most points wins, then higher average EX%, then no winner —
 * a fully tied match needs a referee. See NEW_FORMAT.md and the plan's
 * "Design inconsistencies" writeup for why this exists.
 */
function decisiveWinner(s: MatchState): EntrantId | undefined {
  const ids = idsOf(s);
  const reached = ids.find((id) => (s.points[id] ?? 0) >= POINTS_TO_WIN);
  if (reached) return reached;
  if (!matchOver(s)) return undefined;

  const [x, y] = ids;
  const px = s.points[x!] ?? 0;
  const py = s.points[y!] ?? 0;
  if (px !== py) return px > py ? x : y;

  const exX = averageEx(s, x!);
  const exY = averageEx(s, y!);
  if (exX !== exY) return exX > exY ? x : y;

  return undefined;
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

export function makeHubertFormat(config: HubertConfig): MatchFormat {
  /** Mirrors `protect-veto.ts`'s `escalationOf`, extended with the pool-exhausted-and-fully-tied case (`TIEBREAK_UNRESOLVED`). */
  function escalationOf(s: MatchState): { songIndex?: number; reason: EscalationReason } | undefined {
    if (s.escalation) return s.escalation;
    const ids = idsOf(s);

    const index = s.songs.findIndex((song) => {
      if (song.result) return false;
      const picks = ids.map((id) => song.selections[id]);
      return picks.every((p) => p !== undefined) && new Set(picks).size > 1;
    });
    if (index !== -1) return { songIndex: index, reason: 'WINNER_DISAGREEMENT' };

    const winner = decisiveWinner(s);
    if (winner) {
      const picks = ids.map((id) => s.setWinnerSelections[id]);
      if (picks.every((p) => p !== undefined) && new Set(picks).size > 1) {
        return { reason: 'SET_RESULT_DISAGREEMENT' };
      }
    } else if (matchOver(s)) {
      return { reason: 'TIEBREAK_UNRESOLVED' };
    }

    return undefined;
  }

  function reduce(state: MatchState, event: MatchEvent): MatchState {
    const s: MatchState = {
      ...state,
      seq: event.seq,
      participants: [...state.participants],
      draw: [...state.draw],
      protects: [...state.protects],
      vetoes: [...state.vetoes],
      picks: [...state.picks],
      songs: state.songs.map((x) => ({
        ...x,
        ex: { ...x.ex },
        photoSeen: { ...x.photoSeen },
        selections: { ...x.selections },
      })),
      points: { ...state.points },
      tiebreaks: state.tiebreaks,
      setWinnerSelections: { ...state.setWinnerSelections },
    };

    switch (event.type) {
      case 'MATCH_CREATED':
        s.participants = [...event.payload.participants];
        break;

      case 'SIDES_ASSIGNED':
        s.a = event.payload.a;
        s.b = event.payload.b;
        break;

      case 'DRAW_MADE':
        s.draw = [...event.payload.charts];
        break;

      case 'CHART_VETOED':
        s.vetoes = [...s.vetoes, { drawIndex: event.payload.drawIndex, by: event.payload.by }];
        break;

      case 'CHART_SELECTED':
        s.picks = [...s.picks, { drawIndex: event.payload.drawIndex, by: event.payload.by }];
        break;

      case 'SONG_STARTED':
        s.songs = [
          ...s.songs,
          {
            chart: event.payload.chart,
            source: event.payload.source,
            ...(event.payload.drawIndex !== undefined ? { drawIndex: event.payload.drawIndex } : {}),
            ex: {},
            photoSeen: {},
            selections: {},
          },
        ];
        break;

      case 'SCORE_SUBMITTED': {
        const song = s.songs[event.payload.songIndex];
        if (song) song.ex = { ...song.ex, [event.payload.by]: event.payload.ex };
        break;
      }

      case 'PHOTO_OBSERVED': {
        const song = s.songs[event.payload.songIndex];
        if (song) song.photoSeen = { ...song.photoSeen, [event.payload.by]: true };
        break;
      }

      case 'SONG_WINNER_SELECTED': {
        const song = s.songs[event.payload.songIndex];
        if (song) {
          song.selections = { ...song.selections, [event.payload.by]: event.payload.choice };
          const picks = idsOf(s).map((id) => song.selections[id]);
          if (picks.every((p) => p !== undefined) && new Set(picks).size === 1) {
            song.result = { winner: picks[0]!, by: 'AGREEMENT' };
          }
        }
        break;
      }

      case 'SONG_ESCALATED': {
        const song = s.songs[event.payload.songIndex];
        if (song && !song.result) {
          s.escalation = { songIndex: event.payload.songIndex, reason: event.payload.reason };
        }
        break;
      }

      case 'SONG_RULED': {
        const song = s.songs[event.payload.songIndex];
        if (song && !song.result) {
          song.result = { winner: event.payload.result, by: 'RULING' };
          s.escalation = undefined;
        }
        break;
      }

      case 'SET_RESULT_CONFIRMED':
        s.setWinnerSelections = { ...s.setWinnerSelections, [event.payload.by]: event.payload.choice };
        break;

      case 'SET_RESULT_RULED':
        if (!s.terminal) s.terminal = { winnerId: event.payload.result, by: 'RULING' };
        break;

      case 'FORFEIT_APPLIED':
        if (!s.terminal) s.terminal = { winnerId: event.payload.winnerId, by: 'FORFEIT' };
        break;

      case 'DQ_APPLIED': {
        const survivor = opponentOf(s, event.payload.playerId);
        if (survivor && !s.terminal) s.terminal = { winnerId: survivor, by: 'DQ' };
        break;
      }

      case 'WALKOVER':
        if (!s.terminal) s.terminal = { winnerId: event.payload.winnerId, by: 'WALKOVER' };
        break;

      // `isLegal` allows this whenever a VETO is pending — format-agnostic,
      // same as every other pending kind it checks — so a Hubert match can
      // reach this case even though NEW_FORMAT.md never mentions it. Same
      // semantics as protect-veto.ts's own reset: "the Draw stands; the
      // sequence is cleared, including the seed choice" — here, the coin
      // flip. Only ever reachable before song 1 starts (VETO is only ever
      // pending then), so `s.songs` is already empty; nothing there to undo.
      case 'PROTECT_VETO_RESET':
        s.vetoes = [];
        s.picks = [];
        s.a = undefined;
        s.b = undefined;
        break;

      // Not applicable to this format — never emitted or legal for a Hubert
      // match (no PROTECT step, no human SEED_CHOICE, no private-pick
      // tiebreak round).
      case 'SEED_CHOICE_MADE':
      case 'CHART_PROTECTED':
      case 'TIEBREAK_DRAWN':
      case 'TIEBREAK_CHOICE':
        break;
    }

    s.points = computePoints(s);
    return s;
  }

  function pendingAction(state: MatchState): import('./types.js').PendingAction {
    if (state.terminal) return { kind: 'DONE' };
    if (state.participants.length === 0) return { kind: 'DONE' };

    if (!state.a) {
      return { kind: 'AWAITING_BOT', directive: { do: 'RANDOM_SIDE_ASSIGN' } };
    }

    if (state.draw.length === 0) {
      return { kind: 'AWAITING_BOT', directive: { do: 'DRAW_STATIC' } };
    }

    const escalation = escalationOf(state);
    if (escalation) {
      return escalation.songIndex === undefined
        ? { kind: 'AWAITING_TO', reason: escalation.reason }
        : { kind: 'AWAITING_TO', reason: escalation.reason, songIndex: escalation.songIndex };
    }

    if (state.vetoes.length < config.vetoSequence.length) {
      const who = config.vetoSequence[state.vetoes.length]!;
      const actor = who === 'A' ? state.a : state.b!;
      return { kind: 'VETO', actor, choices: vetoChoicesFor(state, actor) };
    }

    const ids = idsOf(state);
    const active = activeSong(state);
    if (active) {
      const { song, index } = active;
      const incomplete = ids.filter((id) => song.ex[id] === undefined || !song.photoSeen[id]);
      if (incomplete.length > 0) return { kind: 'SUBMIT_SCORE', actors: incomplete, songIndex: index };
      const unselected = ids.filter((id) => song.selections[id] === undefined);
      if (unselected.length > 0) return { kind: 'SELECT_WINNER', actors: unselected, songIndex: index };
    }

    // A pick landed but hasn't started playing yet.
    if (state.picks.length > state.songs.length) {
      const drawIndex = state.picks[state.picks.length - 1]!.drawIndex;
      return { kind: 'AWAITING_BOT', directive: { do: 'START_SONG', source: 'PICK', drawIndex } };
    }

    const winner = decisiveWinner(state);
    if (winner) {
      const undecided = ids.filter((id) => state.setWinnerSelections[id] === undefined);
      return undecided.length > 0 ? { kind: 'CONFIRM_RESULT', actors: undecided } : { kind: 'DONE' };
    }

    if (needsForcedTiebreaker(state)) {
      return {
        kind: 'AWAITING_BOT',
        directive: { do: 'START_SONG', source: 'HB_TIEBREAKER', drawIndex: tbIndex(state) },
      };
    }

    return { kind: 'SELECT_SONG', actor: nextPickActor(state), choices: availableNonTbIndices(state) };
  }

  function outcome(state: MatchState): MatchOutcome | null {
    const place = (winner: EntrantId, by: MatchOutcome['by']): MatchOutcome => ({
      placements: idsOf(state).map((entrantId) => ({
        entrantId,
        place: entrantId === winner ? 1 : 2,
        points: state.points[entrantId] ?? 0,
      })),
      by,
    });

    if (state.terminal) return place(state.terminal.winnerId, state.terminal.by);

    const winner = decisiveWinner(state);
    if (!winner) return null;

    const picks = idsOf(state).map((id) => state.setWinnerSelections[id]);
    if (picks.some((p) => p === undefined) || new Set(picks).size > 1) return null;

    const decidedByRuling = state.songs.some((x) => x.result?.by === 'RULING');
    return place(winner, decidedByRuling ? 'RULING' : 'AGREEMENT');
  }

  function effects(before: MatchState, after: MatchState): DomainEffect[] {
    const out: DomainEffect[] = [];

    after.songs.forEach((song, i) => {
      if (song.result && !before.songs[i]?.result) {
        out.push({ kind: 'SONG_COMMITTED', songIndex: i });
      }
    });

    const wasEscalated = escalationOf(before);
    const isEscalated = escalationOf(after);
    if (!wasEscalated && isEscalated) {
      out.push(
        isEscalated.songIndex === undefined
          ? { kind: 'ESCALATION_OPENED', reason: isEscalated.reason }
          : { kind: 'ESCALATION_OPENED', songIndex: isEscalated.songIndex, reason: isEscalated.reason },
      );
    } else if (wasEscalated && !isEscalated) {
      out.push(
        wasEscalated.songIndex === undefined
          ? { kind: 'ESCALATION_CLOSED' }
          : { kind: 'ESCALATION_CLOSED', songIndex: wasEscalated.songIndex },
      );
    }

    if (!outcome(before) && outcome(after)) out.push({ kind: 'SET_DECIDED' });

    return out;
  }

  return {
    key: config.key,
    drawSize: config.drawSize,
    // The labeled pool already includes the TB song; no separate tiebreak
    // draw to reserve extra songs for, unlike Protect/Veto's formats.
    recommendedPackSize: config.drawSize,
    reduce,
    pendingAction,
    outcome,
    effects,
  };
}

const HB11_VETO_SEQUENCE = ['A', 'B'] as const;
const HB13_VETO_SEQUENCE = ['A', 'B', 'A', 'B'] as const;

export const Hb11StaticPoolFormat: MatchFormat = makeHubertFormat({
  key: 'hb11-static-pool',
  drawSize: 11,
  vetoSequence: HB11_VETO_SEQUENCE,
});

export const Hb13StaticPoolFormat: MatchFormat = makeHubertFormat({
  key: 'hb13-static-pool',
  drawSize: 13,
  vetoSequence: HB13_VETO_SEQUENCE,
});
