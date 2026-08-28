import type { EntrantId, SongRecord } from '../../domain/types.js';

export interface NameLookup {
  (entrantId: EntrantId): string;
}

/**
 * "Per-player ticks for what has landed — EX% submitted, photo seen." See
 * DESIGN.md, "Scoring a song". Never shows the EX% values themselves here
 * — that's only ever a `✅`/`⬜`, since the design compares numbers at
 * winner selection, not before.
 */
export function buildScoreTicksLines(
  song: Pick<SongRecord, 'ex' | 'photoSeen'>,
  participantIds: readonly EntrantId[],
  nameOf: NameLookup,
): string {
  return participantIds
    .map((id) => {
      const ex = song.ex[id] !== undefined ? '✅' : '⬜';
      const photo = song.photoSeen[id] ? '✅' : '⬜';
      return `**${nameOf(id)}**: EX% ${ex}  Photo ${photo}`;
    })
    .join('\n');
}
