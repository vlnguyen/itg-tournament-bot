import type {
  BotDirective,
  DomainEffect,
  EntrantId,
  EscalationReason,
  MatchEvent,
  MatchFormat,
  MatchOutcome,
  MatchState,
  PendingAction,
  SongRecord,
} from './types.js';
import { emptyState } from './types.js';

export const DRAW_SIZE = 7;
export const TIEBREAK_SIZE = 3;
export const POINTS_TO_WIN = 3;

/** ABBAAB. A is whoever took the first Protect. */
const SEQUENCE = [
  { role: 'A', action: 'PROTECT' },
  { role: 'B', action: 'PROTECT' },
  { role: 'B', action: 'VETO' },
  { role: 'A', action: 'VETO' },
  { role: 'A', action: 'PROTECT' },
  { role: 'B', action: 'PROTECT' },
] as const;

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

const idsOf = (s: MatchState): EntrantId[] => s.participants.map((p) => p.entrantId);

function opponentOf(s: MatchState, id: EntrantId): EntrantId | undefined {
  return idsOf(s).find((x) => x !== id);
}

/** The higher seed is the lower seed number, and chooses first or second Protect. */
function higherSeed(s: MatchState): EntrantId | undefined {
  return [...s.participants].sort((x, y) => x.seed - y.seed)[0]?.entrantId;
}

const usedIndices = (s: MatchState): Set<number> =>
  new Set([...s.protects, ...s.vetoes].map((x) => x.drawIndex));

const availableIndices = (s: MatchState): number[] =>
  s.draw.map((_, i) => i).filter((i) => !usedIndices(s).has(i));

const playedDrawIndices = (s: MatchState): Set<number> =>
  new Set(
    s.songs.filter((x) => x.drawIndex !== undefined).map((x) => x.drawIndex as number),
  );

const roleHolder = (s: MatchState, role: 'A' | 'B'): EntrantId | undefined =>
  role === 'A' ? s.a : s.b;

function computePoints(s: MatchState): Record<EntrantId, number> {
  const points: Record<EntrantId, number> = {};
  for (const id of idsOf(s)) points[id] = 0;
  for (const song of s.songs) {
    const winner = song.result?.winner;
    if (winner && winner !== 'TIE' && winner !== 'VOID') {
      points[winner] = (points[winner] ?? 0) + 1;
    }
  }
  return points;
}

const setWinner = (s: MatchState): EntrantId | undefined =>
  idsOf(s).find((id) => (s.points[id] ?? 0) >= POINTS_TO_WIN);

const activeSong = (s: MatchState): { song: SongRecord; index: number } | undefined => {
  const index = s.songs.findIndex((x) => !x.result);
  return index === -1 ? undefined : { song: s.songs[index]!, index };
};

/**
 * Disagreement is *derived*, not stored. Both players selecting different
 * winners is already a complete record of the dispute, so writing a second one
 * would be a record that can disagree with the first — the same objection that
 * keeps commit events out of the log. Only a settings-violation report, which
 * nothing else implies, arrives as an explicit event.
 */
function escalationOf(
  s: MatchState,
): { songIndex: number; reason: EscalationReason } | undefined {
  if (s.escalation) return s.escalation;
  const ids = idsOf(s);
  const index = s.songs.findIndex((song) => {
    if (song.result) return false;
    const picks = ids.map((id) => song.selections[id]);
    return picks.every((p) => p !== undefined) && new Set(picks).size > 1;
  });
  return index === -1 ? undefined : { songIndex: index, reason: 'WINNER_DISAGREEMENT' };
}

// ---------------------------------------------------------------------------
// Play order — fully determined, so the bot advances the set unattended.
// ---------------------------------------------------------------------------

function nextDrawSong(s: MatchState): BotDirective | undefined {
  const played = playedDrawIndices(s);
  const protectsInOrder = s.protects.map((p) => p.drawIndex);
  const unplayedProtects = protectsInOrder.filter((i) => !played.has(i));
  const deciderUnplayed =
    s.deciderIndex !== undefined && !played.has(s.deciderIndex);

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
  const ownUnplayed = s.protects.filter(
    (p) => p.by === loser && !played.has(p.drawIndex),
  );
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

function reduce(state: MatchState, event: MatchEvent): MatchState {
  const s: MatchState = {
    ...state,
    seq: event.seq,
    participants: [...state.participants],
    draw: [...state.draw],
    protects: [...state.protects],
    vetoes: [...state.vetoes],
    songs: state.songs.map((x) => ({ ...x, ex: { ...x.ex }, photoSeen: { ...x.photoSeen }, selections: { ...x.selections } })),
    points: { ...state.points },
    tiebreaks: state.tiebreaks.map((t) => ({ ...t, choices: { ...t.choices } })),
    confirmations: [...state.confirmations],
  };

  switch (event.type) {
    case 'MATCH_CREATED':
      s.participants = [...event.payload.participants];
      break;

    case 'DRAW_MADE':
      s.draw = [...event.payload.charts];
      break;

    case 'SEED_CHOICE_MADE': {
      const chooser = event.payload.by;
      const other = opponentOf(s, chooser);
      if (event.payload.order === 'FIRST') {
        s.a = chooser;
        s.b = other;
      } else {
        s.a = other;
        s.b = chooser;
      }
      break;
    }

    case 'CHART_PROTECTED':
      s.protects = [...s.protects, { drawIndex: event.payload.drawIndex, by: event.payload.by }];
      break;

    case 'CHART_VETOED':
      s.vetoes = [...s.vetoes, { drawIndex: event.payload.drawIndex, by: event.payload.by }];
      break;

    case 'PROTECT_VETO_RESET':
      // The Draw stands; the sequence is cleared, including the seed choice, so
      // the higher seed decides again against the same seven charts.
      s.protects = [];
      s.vetoes = [];
      s.deciderIndex = undefined;
      s.a = undefined;
      s.b = undefined;
      break;

    case 'SONG_STARTED':
      s.songs = [
        ...s.songs,
        {
          chart: event.payload.chart,
          source: event.payload.source,
          ...(event.payload.drawIndex !== undefined
            ? { drawIndex: event.payload.drawIndex }
            : {}),
          ...(event.payload.tiebreakRound !== undefined
            ? { tiebreakRound: event.payload.tiebreakRound }
            : {}),
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
        // Committed on agreement, never written as its own event.
        if (picks.every((p) => p !== undefined) && new Set(picks).size === 1) {
          song.result = { winner: picks[0]!, by: 'AGREEMENT' };
        }
      }
      break;
    }

    case 'SONG_ESCALATED': {
      // A committed song is frozen. A stale report button would otherwise wedge
      // the match in AWAITING_TO with no legal exit, since the only way out is
      // a ruling on a song that no longer needs one.
      const song = s.songs[event.payload.songIndex];
      if (song && !song.result) {
        s.escalation = { songIndex: event.payload.songIndex, reason: event.payload.reason };
      }
      break;
    }

    case 'SONG_RULED': {
      // Results freeze as they commit; nothing rewinds. The transport rejects a
      // ruling on a committed song by validating against pendingAction, but the
      // reducer refuses it too: a corrupted log must not replay into a
      // corrupted result, and this is the guarantee the whole append-only
      // design exists to provide.
      const song = s.songs[event.payload.songIndex];
      if (song && !song.result) {
        song.result = { winner: event.payload.result, by: 'RULING' };
        s.escalation = undefined;
      }
      break;
    }

    case 'TIEBREAK_DRAWN':
      s.tiebreaks = [
        ...s.tiebreaks,
        { round: event.payload.round, charts: [...event.payload.charts], choices: {} },
      ];
      break;

    case 'TIEBREAK_CHOICE': {
      const round = s.tiebreaks.find((t) => t.round === event.payload.round);
      if (round) {
        round.choices = { ...round.choices, [event.payload.by]: event.payload.index };
        const picks = idsOf(s).map((id) => round.choices[id]);
        if (picks.every((p) => p !== undefined)) {
          const unique = new Set(picks as number[]);
          // Same chart plays; different charts mean the unselected one plays.
          round.resolvedIndex =
            unique.size === 1
              ? (picks[0] as number)
              : round.charts.findIndex((_, i) => !unique.has(i));
        }
      }
      break;
    }

    case 'SET_RESULT_CONFIRMED':
      if (!s.confirmations.includes(event.payload.by)) {
        s.confirmations = [...s.confirmations, event.payload.by];
      }
      break;

    // A decided match stays decided. The first terminal event wins, for the
    // same reason a committed song cannot be re-ruled: nothing rewinds. The
    // transport never offers a second, since pendingAction is already DONE.
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
  }

  // Derived, recomputed rather than accumulated so it cannot drift.
  if (s.protects.length === 4 && s.vetoes.length === 2) {
    s.deciderIndex = availableIndices(s)[0];
  }
  s.points = computePoints(s);
  return s;
}

function pendingAction(state: MatchState): PendingAction {
  if (state.terminal) return { kind: 'DONE' };
  if (state.participants.length === 0) return { kind: 'DONE' };

  if (state.draw.length === 0) {
    return { kind: 'AWAITING_BOT', directive: { do: 'DRAW', count: DRAW_SIZE } };
  }

  const escalation = escalationOf(state);
  if (escalation) return { kind: 'AWAITING_TO', reason: escalation.reason };

  if (!state.a) {
    const chooser = higherSeed(state);
    if (!chooser) return { kind: 'DONE' };
    return { kind: 'SEED_CHOICE', actor: chooser };
  }

  const step = state.protects.length + state.vetoes.length;
  if (step < SEQUENCE.length) {
    const { role, action } = SEQUENCE[step]!;
    const actor = roleHolder(state, role);
    if (!actor) return { kind: 'DONE' };
    const choices = availableIndices(state);
    return action === 'PROTECT'
      ? { kind: 'PROTECT', actor, choices }
      : { kind: 'VETO', actor, choices };
  }

  const ids = idsOf(state);
  const active = activeSong(state);
  if (active) {
    const { song, index } = active;
    // Winner selection appears only once both scores and both photos are in.
    const incomplete = ids.filter((id) => song.ex[id] === undefined || !song.photoSeen[id]);
    if (incomplete.length > 0) {
      return { kind: 'SUBMIT_SCORE', actors: incomplete, songIndex: index };
    }
    const unselected = ids.filter((id) => song.selections[id] === undefined);
    if (unselected.length > 0) {
      return { kind: 'SELECT_WINNER', actors: unselected, songIndex: index };
    }
  }

  if (setWinner(state)) {
    const unconfirmed = ids.filter((id) => !state.confirmations.includes(id));
    return unconfirmed.length > 0
      ? { kind: 'CONFIRM_RESULT', actors: unconfirmed }
      : { kind: 'DONE' };
  }

  const nextSong = nextDrawSong(state);
  if (nextSong) return { kind: 'AWAITING_BOT', directive: nextSong };

  // Every chart from the Draw has been played and nobody has reached 3.
  const round = state.tiebreaks[state.tiebreaks.length - 1];
  if (!round) {
    return {
      kind: 'AWAITING_BOT',
      directive: { do: 'DRAW_TIEBREAK', round: 1, count: TIEBREAK_SIZE },
    };
  }

  const undecided = ids.filter((id) => round.choices[id] === undefined);
  if (undecided.length > 0) {
    return {
      kind: 'TIEBREAK_PICK',
      actors: undecided,
      round: round.round,
      choices: round.charts.map((_, i) => i),
    };
  }

  const songForRound = state.songs.find((x) => x.tiebreakRound === round.round);
  if (!songForRound) {
    return {
      kind: 'AWAITING_BOT',
      directive: {
        do: 'START_SONG',
        source: 'TIEBREAK',
        tiebreakRound: round.round,
        chartIndex: round.resolvedIndex!,
      },
    };
  }

  return {
    kind: 'AWAITING_BOT',
    directive: { do: 'DRAW_TIEBREAK', round: round.round + 1, count: TIEBREAK_SIZE },
  };
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

  const winner = setWinner(state);
  if (!winner) return null;
  // Both players must confirm before the set commits.
  if (idsOf(state).some((id) => !state.confirmations.includes(id))) return null;

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

  after.tiebreaks.forEach((round, i) => {
    if (round.resolvedIndex !== undefined && before.tiebreaks[i]?.resolvedIndex === undefined) {
      out.push({ kind: 'TIEBREAK_RESOLVED', round: round.round });
    }
  });

  const wasEscalated = escalationOf(before);
  const isEscalated = escalationOf(after);
  if (!wasEscalated && isEscalated) {
    out.push({
      kind: 'ESCALATION_OPENED',
      songIndex: isEscalated.songIndex,
      reason: isEscalated.reason,
    });
  } else if (wasEscalated && !isEscalated) {
    out.push({ kind: 'ESCALATION_CLOSED', songIndex: wasEscalated.songIndex });
  }

  if (!outcome(before) && outcome(after)) out.push({ kind: 'SET_DECIDED' });

  return out;
}

export const Bo5ProtectVetoFormat: MatchFormat = {
  key: 'bo5-protect-veto',
  drawSize: DRAW_SIZE,
  // A Draw plus one tiebreak round with no repeats.
  recommendedPackSize: DRAW_SIZE + TIEBREAK_SIZE,
  reduce,
  pendingAction,
  outcome,
  effects,
};

export { emptyState };
