import { afterEach, describe, expect, it } from 'vitest';
import type { StandingsRow } from '../../services/advancement-service.js';
import { buildTournamentCompleteAnnouncement } from './tournament-complete.js';

const row = (entrantId: string, seed: number, place: number, displayName: string | null = entrantId): StandingsRow => ({
  entrantId,
  seed,
  displayName,
  place,
});

const ORIGINAL_BASE_URL = process.env['PUBLIC_BASE_URL'];
afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env['PUBLIC_BASE_URL'];
  else process.env['PUBLIC_BASE_URL'] = ORIGINAL_BASE_URL;
});

describe('buildTournamentCompleteAnnouncement', () => {
  it('opens with a trophy in the title, naming the tournament and linking it to the tournament page', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://itg.example.com';
    const message = buildTournamentCompleteAnnouncement('t1', 'Fort Rapids VII', [row('a', 1, 1), row('b', 2, 2)]);
    const embed = message.embeds![0]!;
    expect(embed.data.title).toBe('🏆 Fort Rapids VII — Final Standings');
    expect(embed.data.url).toBe('https://itg.example.com/t/t1');
  });

  it('leaves the title unlinked rather than throwing when PUBLIC_BASE_URL is unset', () => {
    delete process.env['PUBLIC_BASE_URL'];
    const message = buildTournamentCompleteAnnouncement('t1', 'Fort Rapids VII', [row('a', 1, 1)]);
    expect(message.embeds![0]!.data.url).toBeUndefined();
  });

  it('is colored gold', () => {
    const message = buildTournamentCompleteAnnouncement('t1', 'T', [row('a', 1, 1)]);
    expect(message.embeds![0]!.data.color).toBe(0xffd700);
  });

  it('lists placements in order, one line per place', () => {
    const standings = [row('a', 1, 1, 'Alice'), row('b', 2, 2, 'Bob'), row('c', 3, 3, 'Carol'), row('d', 4, 4, 'Dave')];
    const message = buildTournamentCompleteAnnouncement('t1', 'T', standings);
    const lines = message.embeds![0]!.data.description!.split('\n').filter((l) => l.startsWith('**'));
    expect(lines).toEqual(['**1.** Alice', '**2.** Bob', '**3.** Carol', '**4.** Dave']);
  });

  it('joins a tied placement onto one line, seed order', () => {
    const standings = [
      row('a', 1, 1, 'Alice'),
      row('b', 2, 2, 'Bob'),
      row('c', 3, 3, 'Carol'),
      row('d', 4, 4, 'Dave'),
      row('f', 6, 5, 'Frank'),
      row('e', 5, 5, 'Eve'),
      row('h', 8, 7, 'Hank'),
      row('g', 7, 7, 'Grace'),
    ];
    const message = buildTournamentCompleteAnnouncement('t1', 'T', standings);
    const lines = message.embeds![0]!.data.description!.split('\n').filter((l) => l.startsWith('**'));
    expect(lines).toEqual(['**1.** Alice', '**2.** Bob', '**3.** Carol', '**4.** Dave', '**5.** Eve / Frank', '**7.** Grace / Hank']);
  });

  it('excludes anything past 8th', () => {
    const standings = [row('a', 1, 1, 'Alice'), row('z', 16, 13, 'Zed')];
    const message = buildTournamentCompleteAnnouncement('t1', 'T', standings);
    expect(message.embeds![0]!.data.description).not.toContain('Zed');
  });

  it('falls back to the entrant id when displayName is unset', () => {
    const message = buildTournamentCompleteAnnouncement('t1', 'T', [row('entrant-123', 1, 1, null)]);
    expect(message.embeds![0]!.data.description).toContain('entrant-123');
  });
});
