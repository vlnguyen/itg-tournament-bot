import { describe, expect, it } from 'vitest';
import { buildAwaitingRefereeMessage, buildEscalationAlert, buildResolvedAlert } from './escalation.js';

const players = [
  { entrantId: 'alice-id', name: 'Alice' },
  { entrantId: 'bob-id', name: 'Bob' },
] as const;

describe('buildAwaitingRefereeMessage', () => {
  it('is an embed, titled with the scales icon', () => {
    const msg = buildAwaitingRefereeMessage('m1', 'WINNER_DISAGREEMENT', 0, players);
    expect(msg.embeds![0]!.data.title).toBe('⚖️ Awaiting referee');
  });

  it('carries the same ruling buttons as the alert — a referee in the thread can act without switching channels', () => {
    const msg = buildAwaitingRefereeMessage('m1', 'WINNER_DISAGREEMENT', 0, players);
    expect(msg.embeds![0]!.data.description).toContain('winner disagreement');
    const row = msg.components![0]!;
    expect(row.components).toHaveLength(3); // award each player, plus void
  });

  it('names the settings-violation reason distinctly', () => {
    const msg = buildAwaitingRefereeMessage('m1', 'SETTINGS_VIOLATION', 0, players);
    expect(msg.embeds![0]!.data.description).toContain('settings violation');
  });

  it('drops the Void button and says "match" instead of "song" for a set-level disagreement', () => {
    const msg = buildAwaitingRefereeMessage('m1', 'SET_RESULT_DISAGREEMENT', undefined, players);
    expect(msg.embeds![0]!.data.description).toContain('match');
    expect(msg.embeds![0]!.data.description).toContain('who won the set');
    const row = msg.components![0]!;
    expect(row.components).toHaveLength(2);
  });
});

describe('buildEscalationAlert', () => {
  it('has exactly three buttons: award each player, and void', () => {
    const msg = buildEscalationAlert('m1', 0, 'WINNER_DISAGREEMENT', '<@&ref-role>', 'https://thread', players);
    const row = msg.components![0]!;
    expect(row.components).toHaveLength(3);
  });

  it('carries the referee mention as content, separate from the embed', () => {
    const msg = buildEscalationAlert('m1', 0, 'WINNER_DISAGREEMENT', '<@&ref-role>', 'https://thread', players);
    expect(msg.content).toBe('<@&ref-role>');
  });

  it('titles a settings-violation report distinctly from a disagreement', () => {
    const disagreement = buildEscalationAlert('m1', 0, 'WINNER_DISAGREEMENT', '@ref', 'https://t', players);
    const settings = buildEscalationAlert('m1', 0, 'SETTINGS_VIOLATION', '@ref', 'https://t', players);
    expect(disagreement.embeds![0]!.data.title).toBe('Song disagreement');
    expect(settings.embeds![0]!.data.title).toBe('Settings violation reported');
  });
});

describe('buildResolvedAlert', () => {
  it('has no components once resolved', () => {
    const msg = buildResolvedAlert('RefName', 'awarded to Alice');
    expect(msg.components).toBeUndefined();
    expect(msg.content).toContain('RefName');
    expect(msg.content).toContain('awarded to Alice');
  });
});
