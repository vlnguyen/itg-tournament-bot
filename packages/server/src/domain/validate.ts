import type { MatchEvent, PendingAction } from './types.js';

/**
 * "An action is legal iff its actor and value appear in the current
 * `PendingAction`." See DESIGN.md, "Match Format as a Plugin" and "The
 * freeze boundary is enforced by the reducer" — this is the transport-side
 * half of that two-layer check; the reducer's own guards are the second.
 *
 * Pure and format-agnostic: it reads only the shape `PendingAction` already
 * exposes, never a format's internal `MatchState`. A format that changes
 * what it waits on needs no change here.
 */
export function isLegal(pending: PendingAction, event: MatchEvent): boolean {
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

    // A referee rules exactly on the song the match is waiting on.
    case 'SONG_RULED':
      return pending.kind === 'AWAITING_TO' && pending.songIndex === event.payload.songIndex;

    // "A referee may reset the sequence until song 1 has been played." A
    // person only ever observes `pendingAction` once the bot has settled, so
    // "song 1 not yet played" is exactly these three kinds — by the time
    // anything else is pending, `SONG_STARTED` for song 1 has already been
    // auto-appended. See DESIGN.md, "Resetting Protect/Veto".
    case 'PROTECT_VETO_RESET':
      return (
        pending.kind === 'SEED_CHOICE' || pending.kind === 'PROTECT' || pending.kind === 'VETO'
      );

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
      return false;
  }
}
