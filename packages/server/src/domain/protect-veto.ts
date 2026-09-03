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
  WinCondition,
} from './types.js';

/**
 * The engine shared by every Protect/Veto ruleset (`bo5.ts`, `bo3.ts`).
 * Everything here is format-agnostic: the Draw, scoring, escalation, the
 * tiebreak loop, and the Protect/Veto step machinery. What differs between
 * rulesets — the Draw size, points needed to win, who acts at each step of
 * the Protect/Veto sequence, and what song comes next once a result lands —
 * is supplied as `ProtectVetoConfig`. See DESIGN.md, "Match Format as a
 * Plugin".
 */

/** A step's actor, named by role (`A`/`B`, whoever took the first Protect)
 * or by seed (`HIGHER_SEED`/`LOWER_SEED`) — a format picks whichever fits
 * its own rules per step. */
export type SequenceActor = 'A' | 'B' | 'HIGHER_SEED' | 'LOWER_SEED';

export interface ProtectVetoConfig {
  readonly key: string;
  readonly drawSize: number;
  readonly tiebreakSize: number;
  readonly pointsToWin: number;
  readonly sequence: readonly { action: 'PROTECT' | 'VETO'; who: SequenceActor }[];
  /**
   * `-v2` keys set this: once `setWinner` resolves, the set is done — no
   * `CONFIRM_RESULT` step, and `SET_RESULT_CONFIRMED` picks are never
   * requested. Mirrors, one level up, the same "no commit events" rule a
   * song's `SONG_WINNER_SELECTED` already follows. Undefined/false keeps a
   * v1 key's exact existing behavior, since real matches were played under
   * it and its golden fixtures assert the confirm step happens.
   */
  readonly autoComplete?: boolean;
  /**
   * What song starts next, once any active song has committed and nobody
   * has reached `pointsToWin`. Pure, same contract as the rest of the
   * format — the caller supplies the pack and the seed, this only decides
   * which Draw/Decider/tiebreak position is due.
   */
  nextDrawSong(s: MatchState): BotDirective | undefined;
}

// ---------------------------------------------------------------------------
// Reading state — shared by every Protect/Veto format.
// ---------------------------------------------------------------------------

export const idsOf = (s: MatchState): EntrantId[] => s.participants.map((p) => p.entrantId);

export function opponentOf(s: MatchState, id: EntrantId): EntrantId | undefined {
  return idsOf(s).find((x) => x !== id);
}

/** The higher seed is the lower seed number, and chooses first or second Protect. */
export function higherSeed(s: MatchState): EntrantId | undefined {
  return [...s.participants].sort((x, y) => x.seed - y.seed)[0]?.entrantId;
}

const usedIndices = (s: MatchState): Set<number> =>
  new Set([...s.protects, ...s.vetoes].map((x) => x.drawIndex));

export const availableIndices = (s: MatchState): number[] =>
  s.draw.map((_, i) => i).filter((i) => !usedIndices(s).has(i));

export const playedDrawIndices = (s: MatchState): Set<number> =>
  new Set(s.songs.filter((x) => x.drawIndex !== undefined).map((x) => x.drawIndex as number));

const roleHolder = (s: MatchState, role: 'A' | 'B'): EntrantId | undefined =>
  role === 'A' ? s.a : s.b;

/** Resolves a sequence step's `who` against the match's actual players. */
function actorFor(s: MatchState, who: SequenceActor): EntrantId | undefined {
  if (who === 'A' || who === 'B') return roleHolder(s, who);
  const higher = higherSeed(s);
  return who === 'HIGHER_SEED' ? higher : higher && opponentOf(s, higher);
}

/** Shared with `hubert.ts` — points are always "one per committed song won outright", regardless of how a format decides play order. */
export function computePoints(s: MatchState): Record<EntrantId, number> {
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

/** Shared with `hubert.ts` — the one song still awaiting a result, if any; every format's play loop needs this same lookup. */
export const activeSong = (s: MatchState): { song: SongRecord; index: number } | undefined => {
  const index = s.songs.findIndex((x) => !x.result);
  return index === -1 ? undefined : { song: s.songs[index]!, index };
};

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

export function makeProtectVetoFormat(config: ProtectVetoConfig): MatchFormat {
  const setWinner = (s: MatchState): EntrantId | undefined =>
    idsOf(s).find((id) => (s.points[id] ?? 0) >= config.pointsToWin);

  const protectCount = config.sequence.filter((a) => a.action === 'PROTECT').length;
  const vetoCount = config.sequence.filter((a) => a.action === 'VETO').length;

  /**
   * Disagreement is *derived*, not stored. Both players selecting different
   * winners is already a complete record of the dispute, so writing a second
   * one would be a record that can disagree with the first — the same
   * objection that keeps commit events out of the log. Only a
   * settings-violation report, which nothing else implies, arrives as an
   * explicit event.
   *
   * A set-level disagreement is the same idea one level up: once someone has
   * reached `pointsToWin`, each player names who they believe won the set,
   * and two different picks escalate exactly like a song's would — no
   * `songIndex` to attach it to, since it isn't about any one song.
   */
  function escalationOf(
    s: MatchState,
  ): { songIndex?: number; reason: EscalationReason } | undefined {
    if (s.escalation) return s.escalation;
    const ids = idsOf(s);
    const index = s.songs.findIndex((song) => {
      if (song.result) return false;
      const picks = ids.map((id) => song.selections[id]);
      return picks.every((p) => p !== undefined) && new Set(picks).size > 1;
    });
    if (index !== -1) return { songIndex: index, reason: 'WINNER_DISAGREEMENT' };

    if (setWinner(s)) {
      const picks = ids.map((id) => s.setWinnerSelections[id]);
      if (picks.every((p) => p !== undefined) && new Set(picks).size > 1) {
        return { reason: 'SET_RESULT_DISAGREEMENT' };
      }
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
      songs: state.songs.map((x) => ({
        ...x,
        ex: { ...x.ex },
        photoSeen: { ...x.photoSeen },
        selections: { ...x.selections },
      })),
      points: { ...state.points },
      tiebreaks: state.tiebreaks.map((t) => ({ ...t, choices: { ...t.choices } })),
      setWinnerSelections: { ...state.setWinnerSelections },
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
        // the higher seed decides again against the same charts.
        s.protects = [];
        s.vetoes = [];
        s.deciderIndex = undefined;
        s.a = undefined;
        s.b = undefined;
        // `isLegal` now also allows this once song 1 has started (picked,
        // scored, even winner-selected) but not yet committed — exactly one
        // song is ever live without a `result` at a time, so dropping it
        // here is what actually undoes that far, not just the sequence.
        // Leaving it in `s.songs` would have the redo's own song 1 land at
        // index 1 instead of overwriting it, corrupting every index-based
        // read of the songs array from there on. Frees its chart's
        // `drawIndex` for `nextDrawSong` too, same as any other undo.
        if (s.songs.length > 0 && !s.songs[s.songs.length - 1]!.result) {
          s.songs = s.songs.slice(0, -1);
          s.escalation = undefined;
        }
        break;

      case 'SONG_STARTED':
        s.songs = [
          ...s.songs,
          {
            chart: event.payload.chart,
            source: event.payload.source,
            ...(event.payload.drawIndex !== undefined ? { drawIndex: event.payload.drawIndex } : {}),
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
              unique.size === 1 ? (picks[0] as number) : round.charts.findIndex((_, i) => !unique.has(i));
          }
        }
        break;
      }

      case 'SET_RESULT_CONFIRMED':
        s.setWinnerSelections = { ...s.setWinnerSelections, [event.payload.by]: event.payload.choice };
        break;

      // A referee's ruling on a set-level disagreement — same "first terminal
      // event wins" rule as the other terminal events below.
      case 'SET_RESULT_RULED':
        if (!s.terminal) s.terminal = { winnerId: event.payload.result, by: 'RULING' };
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
    if (s.protects.length === protectCount && s.vetoes.length === vetoCount) {
      s.deciderIndex = availableIndices(s)[0];
    }
    s.points = computePoints(s);
    return s;
  }

  function pendingAction(state: MatchState): PendingAction {
    if (state.terminal) return { kind: 'DONE' };
    if (state.participants.length === 0) return { kind: 'DONE' };

    if (state.draw.length === 0) {
      return { kind: 'AWAITING_BOT', directive: { do: 'DRAW', count: config.drawSize } };
    }

    const escalation = escalationOf(state);
    if (escalation) {
      return escalation.songIndex === undefined
        ? { kind: 'AWAITING_TO', reason: escalation.reason }
        : { kind: 'AWAITING_TO', reason: escalation.reason, songIndex: escalation.songIndex };
    }

    if (!state.a) {
      const chooser = higherSeed(state);
      if (!chooser) return { kind: 'DONE' };
      return { kind: 'SEED_CHOICE', actor: chooser };
    }

    const step = state.protects.length + state.vetoes.length;
    if (step < config.sequence.length) {
      const { who, action } = config.sequence[step]!;
      const actor = actorFor(state, who);
      if (!actor) return { kind: 'DONE' };
      const choices = availableIndices(state);
      return action === 'PROTECT' ? { kind: 'PROTECT', actor, choices } : { kind: 'VETO', actor, choices };
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
      if (config.autoComplete) return { kind: 'DONE' };
      // A disagreement between the two picks is caught by `escalationOf`
      // above, before this is ever reached — reaching here with both picks in
      // means they agree, so there is nothing left to do but finish.
      const undecided = ids.filter((id) => state.setWinnerSelections[id] === undefined);
      return undecided.length > 0 ? { kind: 'CONFIRM_RESULT', actors: undecided } : { kind: 'DONE' };
    }

    const nextSong = config.nextDrawSong(state);
    if (nextSong) return { kind: 'AWAITING_BOT', directive: nextSong };

    // Every chart from the Draw has been played and nobody has reached the target.
    const round = state.tiebreaks[state.tiebreaks.length - 1];
    if (!round) {
      return {
        kind: 'AWAITING_BOT',
        directive: { do: 'DRAW_TIEBREAK', round: 1, count: config.tiebreakSize },
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
      directive: { do: 'DRAW_TIEBREAK', round: round.round + 1, count: config.tiebreakSize },
    };
  }

  function outcome(state: MatchState): MatchOutcome | null {
    const place = (
      winner: EntrantId,
      by: MatchOutcome['by'],
      winCondition?: WinCondition,
    ): MatchOutcome => ({
      placements: idsOf(state).map((entrantId) => ({
        entrantId,
        place: entrantId === winner ? 1 : 2,
        points: state.points[entrantId] ?? 0,
      })),
      by,
      ...(winCondition ? { winCondition } : {}),
    });

    if (state.terminal) return place(state.terminal.winnerId, state.terminal.by);

    const winner = setWinner(state);
    if (!winner) return null;

    if (!config.autoComplete) {
      // Both players must pick a set winner before it commits, and their
      // picks must actually agree — `outcome()` is read independently of
      // `pendingAction()`/`escalationOf`, so it has to make this check
      // itself rather than relying on the escalation having already fired
      // elsewhere. A disagreement resolves only through `SET_RESULT_RULED`,
      // which sets `state.terminal` and is handled above.
      const picks = idsOf(state).map((id) => state.setWinnerSelections[id]);
      if (picks.some((p) => p === undefined) || new Set(picks).size > 1) return null;
    }

    const decidedByRuling = state.songs.some((x) => x.result?.by === 'RULING');
    // `winCondition` is new, `-v2`-only surface — a v1 key's `outcome()` must
    // return exactly what it always has, unchanged in shape as well as
    // value, since real matches were played under it and the golden corpus
    // pins its exact output. Bo3/Bo5 never fall through to a forced
    // tiebreaker song or an average-EX% break either way — reaching
    // `pointsToWin` is the only way `setWinner` resolves.
    const winCondition = config.autoComplete && !decidedByRuling ? 'POINTS' : undefined;
    return place(winner, decidedByRuling ? 'RULING' : 'AGREEMENT', winCondition);
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
    // A Draw plus one clean tiebreak round with no repeats.
    recommendedPackSize: config.drawSize + config.tiebreakSize,
    reduce,
    pendingAction,
    outcome,
    effects,
  };
}
