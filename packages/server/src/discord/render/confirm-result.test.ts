import { describe, expect, it } from 'vitest';
import { buildConfirmResultMessage } from './confirm-result.js';

const names = new Map([
  ['alice', 'Alice'],
  ['bob', 'Bob'],
]);
const nameOf = (id: string) => names.get(id) ?? id;

describe('buildConfirmResultMessage', () => {
  it('shows both players’ points as a hint, without preselecting a winner', () => {
    const message = buildConfirmResultMessage('m1', { alice: 3, bob: 1 }, ['alice', 'bob'], nameOf);
    expect(message.embeds![0]!.data.description).toContain('**Alice**: 3');
    expect(message.embeds![0]!.data.description).toContain('**Bob**: 1');
  });

  it('has one button per participant, no tie option', () => {
    const message = buildConfirmResultMessage('m1', { alice: 3, bob: 1 }, ['alice', 'bob'], nameOf);
    const row = message.components![0]!;
    expect(row.components).toHaveLength(2);
  });

  it('labels each button with the player’s name', () => {
    const message = buildConfirmResultMessage('m1', { alice: 3, bob: 1 }, ['alice', 'bob'], nameOf);
    const labels = message.components![0]!.components.map((c) => (c.data as { label?: string }).label);
    expect(labels).toEqual(['Alice', 'Bob']);
  });
});
