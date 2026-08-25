import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import type { MatchOutcome } from '../../domain/types.js';
import type { PublicMatch } from '../../domain/projection.js';
import { buildResultAnnouncement, buildResultSummaryEmbed } from './result-summary.js';

const chart = (n: number): ChartSnapshot => ({
  chartId: `c${n}`,
  title: `Song ${n}`,
  titleTranslit: null,
  subtitle: null,
  subtitleTranslit: null,
  artist: null,
  artistTranslit: null,
  playStyle: 'SINGLE',
  difficulty: 'EXPERT',
  meter: 12,
  stepartist: null,
  description: null,
  sourcePack: null,
  flags: [],
});

const names = new Map([
  ['alice', 'Alice'],
  ['bob', 'Bob'],
]);
const nameOf = (id: string) => names.get(id) ?? id;
const participantIds: readonly ['alice', 'bob'] = ['alice', 'bob'];

const song = (i: number, winner: 'alice' | 'bob' | 'TIE' | 'VOID', tiebreakRound?: number): PublicMatch['songs'][number] => ({
  index: i,
  chart: chart(i + 1),
  source: 'FIRST_PROTECT',
  tiebreakRound,
  ex: { alice: 96.5, bob: 94.2 },
  photoSeen: { alice: true, bob: true },
  selections: { alice: winner === 'TIE' || winner === 'VOID' ? 'TIE' : winner, bob: winner === 'TIE' || winner === 'VOID' ? 'TIE' : winner },
  result: { winner, by: 'AGREEMENT' },
});

const outcome: MatchOutcome = {
  placements: [
    { entrantId: 'alice', place: 1, points: 3 },
    { entrantId: 'bob', place: 2, points: 1 },
  ],
  by: 'AGREEMENT',
};

describe('buildResultSummaryEmbed', () => {
  it('titles the embed with the winner and final score', () => {
    const embed = buildResultSummaryEmbed([song(0, 'alice')], { alice: 3, bob: 1 }, outcome, participantIds, nameOf);
    expect(embed.data.title).toBe('Match complete — Alice wins 3–1');
  });

  it('lists each song with both EX% values and the winner', () => {
    const embed = buildResultSummaryEmbed([song(0, 'alice'), song(1, 'bob')], { alice: 3, bob: 1 }, outcome, participantIds, nameOf);
    const lines = embed.data.description!.split('\n');
    expect(lines[0]).toContain('Alice 96.50%');
    expect(lines[0]).toContain('Bob 94.20%');
    expect(lines[0]).toContain('Alice wins');
    expect(lines[1]).toContain('Bob wins');
  });

  it('labels a tiebreak song distinctly from a numbered song', () => {
    const embed = buildResultSummaryEmbed([song(5, 'alice', 1)], { alice: 3, bob: 2 }, outcome, participantIds, nameOf);
    expect(embed.data.description).toContain('**Tiebreak 1**');
  });

  it('notes how the set was decided when not by agreement', () => {
    const ruled: MatchOutcome = { ...outcome, by: 'RULING' };
    const embed = buildResultSummaryEmbed([song(0, 'alice')], { alice: 3, bob: 1 }, ruled, participantIds, nameOf);
    expect(embed.data.title).toContain('(by referee ruling)');
  });
});

describe('buildResultAnnouncement', () => {
  it('reports the round label, winner, loser, and score for an ordinary decision', () => {
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf);
    expect(message.content).toBe('🏁 WR2 — **Alice** defeats **Bob** 3–1');
  });

  it('words a forfeit as advancement rather than a scoreline', () => {
    const forfeited: MatchOutcome = { ...outcome, by: 'FORFEIT' };
    const message = buildResultAnnouncement('WINNERS', 2, forfeited, { alice: 0, bob: 0 }, participantIds, nameOf);
    expect(message.content).toBe('🏁 WR2 — **Alice** advances');
  });
});
