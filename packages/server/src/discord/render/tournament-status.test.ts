import { describe, expect, it } from 'vitest';
import { buildTournamentStatusMessage } from './tournament-status.js';

function description(msg: ReturnType<typeof buildTournamentStatusMessage>): string {
  return msg.embeds![0]!.data.description!;
}

describe('buildTournamentStatusMessage', () => {
  it('says so when there are no matches yet', () => {
    const msg = buildTournamentStatusMessage('Fall Kickoff', []);
    expect(description(msg)).toBe('No matches yet.');
  });

  it('tallies each bracket/round group independently', () => {
    const msg = buildTournamentStatusMessage('Fall Kickoff', [
      { bracket: 'WINNERS', round: 1, status: 'COMPLETE' },
      { bracket: 'WINNERS', round: 1, status: 'COMPLETE' },
      { bracket: 'WINNERS', round: 1, status: 'IN_PROGRESS' },
      { bracket: 'WINNERS', round: 1, status: 'PENDING' },
      { bracket: 'WINNERS', round: 2, status: 'PENDING' },
    ]);
    const text = description(msg);
    expect(text).toContain('**Winners Round 1**: 2 complete, 1 in progress, 1 pending');
    expect(text).toContain('**Winners Round 2**: 1 pending');
  });

  it('orders Winners before Losers before Grand Final, then by round', () => {
    const msg = buildTournamentStatusMessage('Fall Kickoff', [
      { bracket: 'GRAND_FINAL', round: 1, status: 'PENDING' },
      { bracket: 'LOSERS', round: 1, status: 'PENDING' },
      { bracket: 'WINNERS', round: 2, status: 'PENDING' },
      { bracket: 'WINNERS', round: 1, status: 'PENDING' },
    ]);
    const text = description(msg);
    const order = ['Winners Round 1', 'Winners Round 2', 'Losers Round 1', 'Grand Final'].map((label) => text.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('titles the embed with the tournament name', () => {
    const msg = buildTournamentStatusMessage('Fall Kickoff', []);
    expect(msg.embeds![0]!.data.title).toBe('Tournament Status: Fall Kickoff');
  });
});
