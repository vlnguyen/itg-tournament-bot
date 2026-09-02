import { afterEach, describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import type { MatchOutcome } from '../../domain/types.js';
import type { PublicMatch } from '../../domain/projection.js';
import { buildResultAnnouncement, buildResultSummaryEmbed } from './result-summary.js';

const ORIGINAL_BASE_URL = process.env['PUBLIC_BASE_URL'];
afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env['PUBLIC_BASE_URL'];
  else process.env['PUBLIC_BASE_URL'] = ORIGINAL_BASE_URL;
});

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
  description: null,  sourcePack: null,
  flags: [],
  poolLabel: null,
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
    expect(embed.data.title).toBe('Match complete: Alice wins 3–1');
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
    expect(embed.data.description).toBe('No songs played.');
  });
});

describe('buildResultAnnouncement', () => {
  it('titles the embed with the round label and both names, linked to the match', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://itg.example.com';
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf, 't1', 'm1', 'Fort Rapids VII', []);
    const embed = message.embeds![0]!;
    expect(embed.data.title).toBe('WR2: Alice vs Bob');
    expect(embed.data.url).toBe('https://itg.example.com/t/t1/matches/m1');
  });

  it('leaves the title unlinked rather than throwing when PUBLIC_BASE_URL is unset', () => {
    delete process.env['PUBLIC_BASE_URL'];
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf, 't1', 'm1', 'Fort Rapids VII', []);
    expect(message.embeds![0]!.data.url).toBeUndefined();
  });

  it('describes who advances, the score, and links the tournament name below a blank line', () => {
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf, 't1', 'm1', 'Fort Rapids VII', []);
    const embed = message.embeds![0]!;
    expect(embed.data.description).toBe('Alice advances (3-1)\n\n[Fort Rapids VII](/t/t1)');
  });

  it('is colored green', () => {
    const message = buildResultAnnouncement('WINNERS', 2, outcome, { alice: 3, bob: 1 }, participantIds, nameOf, 't1', 'm1', 'Fort Rapids VII', []);
    expect(message.embeds![0]!.data.color).toBe(0x2ecc71);
  });

  it('uses the same "advances (score)" wording for a forfeit, not a defeats-scoreline', () => {
    const forfeited: MatchOutcome = { ...outcome, by: 'FORFEIT' };
    const message = buildResultAnnouncement('WINNERS', 2, forfeited, { alice: 0, bob: 0 }, participantIds, nameOf, 't1', 'm1', 'T', []);
    expect(message.embeds![0]!.data.description).toContain('Alice advances (0-0)');
  });

  it('names both players in seat order regardless of who won', () => {
    const bobWins: MatchOutcome = {
      placements: [
        { entrantId: 'alice', place: 2, points: 1 },
        { entrantId: 'bob', place: 1, points: 3 },
      ],
      by: 'AGREEMENT',
    };
    const message = buildResultAnnouncement('LOSERS', 3, bobWins, { alice: 1, bob: 3 }, participantIds, nameOf, 't1', 'm1', 'T', []);
    const embed = message.embeds![0]!;
    expect(embed.data.title).toBe('LR3: Alice vs Bob');
    expect(embed.data.description).toContain('Bob advances (3-1)');
  });

  it('lists each song played, numbered but without "Song N" wording, and its winner as a trophy plus name, without EX%', () => {
    const message = buildResultAnnouncement(
      'WINNERS',
      2,
      outcome,
      { alice: 3, bob: 1 },
      participantIds,
      nameOf,
      't1',
      'm1',
      'Fort Rapids VII',
      [song(0, 'alice'), song(1, 'bob')],
    );
    const embed = message.embeds![0]!;
    expect(embed.data.description).toBe(
      ['Alice advances (3-1)', '', '1. **Song 1 SX 12**: 🏆 Alice', '2. **Song 2 SX 12**: 🏆 Bob', '', '[Fort Rapids VII](/t/t1)'].join('\n'),
    );
    expect(embed.data.description).not.toContain('%');
  });

  it('labels a tied song with a handshake icon and "Tie", distinct from a decided one', () => {
    const message = buildResultAnnouncement(
      'WINNERS',
      2,
      outcome,
      { alice: 3, bob: 1 },
      participantIds,
      nameOf,
      't1',
      'm1',
      'T',
      [song(5, 'TIE', 1)],
    );
    expect(message.embeds![0]!.data.description).toContain('6. **Tiebreak 1 (Song 6 SX 12)**: 🤝 Tie');
  });

  it('omits the song list entirely when no songs were played', () => {
    const dqBeforeAnySong: MatchOutcome = { ...outcome, by: 'DQ' };
    const message = buildResultAnnouncement('WINNERS', 2, dqBeforeAnySong, { alice: 0, bob: 0 }, participantIds, nameOf, 't1', 'm1', 'T', []);
    expect(message.embeds![0]!.data.description).toBe('Alice advances (0-0)\n\n[T](/t/t1)');
  });
});
