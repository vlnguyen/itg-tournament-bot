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

  it('does not throw building an embed for a DQ/forfeit before any song was played', () => {
    // `EmbedBuilder.setDescription('')` throws — a DQ or forfeit is legal at
    // any point before the match is DONE, including mid Protect/Veto, when
    // `songs` is still empty. Regression for exactly that crash.
    const dqBeforeAnySong: MatchOutcome = { ...outcome, by: 'DQ' };
    expect(() => buildResultSummaryEmbed([], { alice: 0, bob: 0 }, dqBeforeAnySong, participantIds, nameOf)).not.toThrow();
    const embed = buildResultSummaryEmbed([], { alice: 0, bob: 0 }, dqBeforeAnySong, participantIds, nameOf);
    expect(embed.data.description).toBe('No songs were played.');
  });
});

describe('buildResultAnnouncement', () => {
  it('reports the flag, round label, both names, the winner, and the score for an ordinary decision', () => {
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf);
    expect(message.content).toBe('🏁 WR2 · Alice vs Bob - Alice advances (3-1)');
  });

  it('uses the same "advances (score)" wording for a forfeit, not a defeats-scoreline', () => {
    const forfeited: MatchOutcome = { ...outcome, by: 'FORFEIT' };
    const message = buildResultAnnouncement('WINNERS', 2, forfeited, { alice: 0, bob: 0 }, participantIds, nameOf);
    expect(message.content).toBe('🏁 WR2 · Alice vs Bob - Alice advances (0-0)');
  });

  it('names both players in seat order regardless of who won', () => {
    const bobWins: MatchOutcome = {
      placements: [
        { entrantId: 'alice', place: 2, points: 1 },
        { entrantId: 'bob', place: 1, points: 3 },
      ],
      by: 'AGREEMENT',
    };
    const message = buildResultAnnouncement('LOSERS', 3, bobWins, { alice: 1, bob: 3 }, participantIds, nameOf);
    expect(message.content).toBe('🏁 LR3 · Alice vs Bob - Bob advances (3-1)');
  });
});
