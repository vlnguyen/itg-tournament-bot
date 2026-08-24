import type { MatchEvent, MatchOutcome, SongRecord } from '../types.js';

/**
 * An archived event log plus what it must still decide the same way on
 * replay. See DESIGN.md, "Format versioning and golden replay": "every
 * committed song result, set result, and final placement must come out
 * identical." Those three things are exactly `committedSongs` and `outcome`
 * below — nothing else about `MatchState` is pinned, so an unrelated shape
 * change (a new field, a rename) does not fail the corpus for no reason.
 */
export interface GoldenFixture {
  name: string;
  /** What this log ran under. Replay must look this up, not assume the current default. */
  formatKey: string;
  events: MatchEvent[];
  expected: {
    committedSongs: { source: string; result: SongRecord['result'] }[];
    outcome: MatchOutcome | null;
  };
}
