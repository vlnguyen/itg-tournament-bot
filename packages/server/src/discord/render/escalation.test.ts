import { describe, expect, it } from 'vitest';
import { buildAwaitingRefereeMessage, buildEscalationAlert, buildResolvedAlert } from './escalation.js';

const players = [
  { entrantId: 'alice-id', name: 'Alice' },
  { entrantId: 'bob-id', name: 'Bob' },
] as const;

describe('buildAwaitingRefereeMessage', () => {
  it('carries no components — nothing is legal until a referee rules', () => {
    const msg = buildAwaitingRefereeMessage('WINNER_DISAGREEMENT');
    expect(msg.components).toBeUndefined();
    expect(msg.content).toContain('winner disagreement');
  });

  it('names the settings-violation reason distinctly', () => {
    const msg = buildAwaitingRefereeMessage('SETTINGS_VIOLATION');
    expect(msg.content).toContain('settings violation');
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
