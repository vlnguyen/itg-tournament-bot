import type { MatchEvent, MatchState, PendingAction } from './types.js';

/**
 * Whether song 1 is still uncommitted — no song has a `result` yet. Every
 * format plays its songs strictly in order with exactly one live at a time,
 * so this is equivalent to "song 1 specifically hasn't committed," without
 * needing to name it by index. Shared by `isLegal`'s `PROTECT_VETO_RESET`
 * window and by `state-message.ts`, so the reset button only ever appears
 * where pressing it would actually be accepted.
 */
export function songOneUncommitted(state: MatchState): boolean {
  return state.songs.every((s) => s.result === undefined);
}

/**
 * "An action is legal iff its actor and value appear in the current
 * `PendingAction`." See DESIGN.md, "Match Format as a Plugin" and "The
 * freeze boundary is enforced by the reducer" — this is the transport-side
 * half of that two-layer check; the reducer's own guards are the second.
 *
 * Format-agnostic: it reads only the shape `PendingAction` already exposes,
 * never a format's internal `MatchState` — with one exception,
 * `PROTECT_VETO_RESET`, which needs `state` to tell "song 1, not yet
 * committed" apart from every later occurrence of the same pending kinds.
 * `state` is optional and that one case fails closed without it, so every
 * other call site (and the 40-odd existing tests that construct a bare
 * `PendingAction` by hand) is unaffected.
 */
export function isLegal(pending: PendingAction, event: MatchEvent, state?: MatchState): boolean {
  switch (event.type) {
    case 'SEED_CHOICE_MADE':
      return pending.kind === 'SEED_CHOICE' && pending.actor === event.payload.by;

    case 'CHART_PROTECTED':
      return (
        pending.kind === 'PROTECT' &&
        pending.actor === event.payload.by &&
        pending.choices.includes(event.payload.drawIndex)
      );

    case 'CHART_VETOED':
      return (
        pending.kind === 'VETO' &&
        pending.actor === event.payload.by &&
        pending.choices.includes(event.payload.drawIndex)
      );

    case 'CHART_SELECTED':
      return (
        pending.kind === 'SELECT_SONG' &&
        pending.actor === event.payload.by &&
        pending.choices.includes(event.payload.drawIndex)
      );

    case 'SCORE_SUBMITTED':
      return (
        pending.kind === 'SUBMIT_SCORE' &&
        pending.songIndex === event.payload.songIndex &&
        pending.actors.includes(event.payload.by)
      );

    // Bot-detected, but gated on the same window as the score it accompanies
    // — a photo for a song nobody is submitting a score for has nothing to
    // attach to.
    case 'PHOTO_OBSERVED':
      return (
        pending.kind === 'SUBMIT_SCORE' &&
        pending.songIndex === event.payload.songIndex &&
        pending.actors.includes(event.payload.by)
      );

    case 'SONG_WINNER_SELECTED':
      return (
        pending.kind === 'SELECT_WINNER' &&
        pending.songIndex === event.payload.songIndex &&
        pending.actors.includes(event.payload.by)
      );

    // "The button disappears once the song commits" — legal for exactly the
    // window the song it names is still live: submitting scores or picking a
    // winner. See DESIGN.md, "Reporting a settings violation".
    case 'SONG_ESCALATED':
      return (
        (pending.kind === 'SUBMIT_SCORE' || pending.kind === 'SELECT_WINNER') &&
        pending.songIndex === event.payload.songIndex
      );

    case 'TIEBREAK_CHOICE':
      return (
        pending.kind === 'TIEBREAK_PICK' &&
        pending.round === event.payload.round &&
        pending.actors.includes(event.payload.by) &&
        pending.choices.includes(event.payload.index)
      );

    case 'SET_RESULT_CONFIRMED':
      return pending.kind === 'CONFIRM_RESULT' && pending.actors.includes(event.payload.by);

    // A referee may rule on the song the match is currently waiting on —
    // still being played (`SUBMIT_SCORE`/`SELECT_WINNER`), or already
    // escalated (`AWAITING_TO`) — pre-empting the players' own agreement
    // path rather than only resolving a disagreement they've already
    // reached. Never a song that's already committed or hasn't started:
    // exactly one song is ever "current" at a time, so matching its index
    // is equivalent to the reducer's own `!song.result` guard without
    // needing raw `MatchState` here. See DESIGN.md, "The freeze boundary
    // is enforced by the reducer" — consistent with DQ/Forfeit's existing
    // "legal any time the match isn't done," not a new kind of exception.
    case 'SONG_RULED':
      return (
        (pending.kind === 'SUBMIT_SCORE' || pending.kind === 'SELECT_WINNER' || pending.kind === 'AWAITING_TO') &&
        pending.songIndex === event.payload.songIndex
      );

    // A referee may decide the set's overall outcome at any point before
    // it's done — same "legal any time the match isn't done" precedent as
    // FORFEIT_APPLIED/DQ_APPLIED below, not gated on an actual set-result
    // disagreement having happened.
    case 'SET_RESULT_RULED':
      return pending.kind !== 'DONE';

    // "A referee may reset the sequence until song 1 has been played." Before
    // any pick lands, that's exactly these three kinds. Once a pick or a
    // song exists, "song 1 not yet played" means "song 1 hasn't committed a
    // result" — a wrong veto or pick is just as catchable after song 1 has
    // been picked, started, scored, or even selection-disagreed-on, right up
    // until both players' agreement (or a ruling) locks it in. `SELECT_SONG`
    // (Hubert's formats only), `SUBMIT_SCORE`, and `SELECT_WINNER` all recur
    // for every later song too, which is exactly why this needs `state`
    // rather than pending kind alone — `songOneUncommitted` is false again
    // the moment song 1 actually commits. See DESIGN.md, "Resetting
    // Protect/Veto".
    case 'PROTECT_VETO_RESET':
      if (pending.kind === 'SEED_CHOICE' || pending.kind === 'PROTECT' || pending.kind === 'VETO') return true;
      if (pending.kind === 'SELECT_SONG' || pending.kind === 'SUBMIT_SCORE' || pending.kind === 'SELECT_WINNER') {
        return !!state && songOneUncommitted(state);
      }
      return false;

    // Terminal referee rulings: legal any time the match isn't already done.
    // "Nothing rewinds" is the reducer's guard (the first terminal event
    // wins); this is only the coarse "is there still a match to end" check.
    case 'FORFEIT_APPLIED':
    case 'DQ_APPLIED':
      return pending.kind !== 'DONE';

    // System-authored. Never arrive through the validated append path — the
    // engine appends these directly while settling `AWAITING_BOT`, or while
    // materializing the bracket.
    case 'MATCH_CREATED':
    case 'DRAW_MADE':
    case 'SONG_STARTED':
    case 'TIEBREAK_DRAWN':
    case 'WALKOVER':
    case 'SIDES_ASSIGNED':
      return false;
  }
}
