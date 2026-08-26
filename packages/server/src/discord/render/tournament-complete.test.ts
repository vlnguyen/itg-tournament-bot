import { describe, expect, it } from 'vitest';
import type { StandingsRow } from '../../services/advancement-service.js';
import { buildTournamentCompleteAnnouncement } from './tournament-complete.js';

const row = (entrantId: string, seed: number, place: number, displayName: string | null = entrantId): StandingsRow => ({
  entrantId,
  seed,
  displayName,
  place,
});

describe('buildTournamentCompleteAnnouncement', () => {
  it('opens with a trophy and a ## header naming the tournament', () => {
    const message = buildTournamentCompleteAnnouncement('Fort Rapids VII', [row('a', 1, 1), row('b', 2, 2)]);
    expect(message.content).toMatch(/^## 🏆 Fort Rapids VII — Final Standings/);
  });

  it('lists placements in order, one line per place', () => {
    const standings = [row('a', 1, 1, 'Alice'), row('b', 2, 2, 'Bob'), row('c', 3, 3, 'Carol'), row('d', 4, 4, 'Dave')];
    const message = buildTournamentCompleteAnnouncement('T', standings);
    const lines = message.content!.split('\n').filter((l) => l.startsWith('**'));
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
    const message = buildTournamentCompleteAnnouncement('T', standings);
    const lines = message.content!.split('\n').filter((l) => l.startsWith('**'));
    expect(lines).toEqual(['**1.** Alice', '**2.** Bob', '**3.** Carol', '**4.** Dave', '**5.** Eve / Frank', '**7.** Grace / Hank']);
  });

  it('excludes anything past 8th', () => {
    const standings = [row('a', 1, 1, 'Alice'), row('z', 16, 13, 'Zed')];
    const message = buildTournamentCompleteAnnouncement('T', standings);
    expect(message.content).not.toContain('Zed');
  });

  it('falls back to the entrant id when displayName is unset', () => {
    const message = buildTournamentCompleteAnnouncement('T', [row('entrant-123', 1, 1, null)]);
    expect(message.content).toContain('entrant-123');
  });
});
