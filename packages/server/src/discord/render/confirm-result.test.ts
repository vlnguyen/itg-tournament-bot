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

  it('shows average EX% next to points when songs were played', () => {
    const songs = [{ ex: { alice: 100, bob: 99.98 } }, { ex: { alice: 99.98, bob: 99.98 } }];
    const message = buildConfirmResultMessage('m1', { alice: 2, bob: 2 }, ['alice', 'bob'], nameOf, songs);
    expect(message.embeds![0]!.data.description).toContain('**Alice**: 2 (avg. 99.99%)');
    expect(message.embeds![0]!.data.description).toContain('**Bob**: 2 (avg. 99.98%)');
  });

  it('omits the average for a player with no submitted score, rather than showing NaN', () => {
    const songs = [{ ex: { alice: 95 } }]; // bob never submitted (e.g. a forfeit)
    const message = buildConfirmResultMessage('m1', { alice: 1, bob: 0 }, ['alice', 'bob'], nameOf, songs);
    expect(message.embeds![0]!.data.description).toContain('**Alice**: 1 (avg. 95.00%)');
    expect(message.embeds![0]!.data.description).toContain('**Bob**: 0');
    expect(message.embeds![0]!.data.description).not.toContain('Bob**: 0 (avg');
  });

  it('omits the average entirely when no songs were played at all', () => {
    const message = buildConfirmResultMessage('m1', { alice: 3, bob: 1 }, ['alice', 'bob'], nameOf);
    expect(message.embeds![0]!.data.description).not.toContain('avg.');
  });
});
