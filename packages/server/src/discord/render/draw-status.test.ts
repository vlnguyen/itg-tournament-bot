import { describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '@itg/shared';
import { buildDrawStatusLines } from './draw-status.js';

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

const draw = [chart(1), chart(2), chart(3)];
const names = new Map([
  ['alice', 'Alice'],
  ['bob', 'Bob'],
]);
const nameOf = (id: string) => names.get(id) ?? id;

describe('buildDrawStatusLines', () => {
  it('shows an untouched chart plainly', () => {
    const lines = buildDrawStatusLines({ draw, protects: [], vetoes: [], deciderIndex: undefined }, nameOf);
    expect(lines.split('\n')[0]).toBe('1. Song 1 SX 12');
  });

  it('marks a protected chart, still legible (not struck through)', () => {
    const lines = buildDrawStatusLines(
      { draw, protects: [{ drawIndex: 0, by: 'alice' }], vetoes: [], deciderIndex: undefined },
      nameOf,
    );
    expect(lines.split('\n')[0]).toBe('1. Song 1 SX 12 🛡️ Protected by Alice');
  });

  it('marks a vetoed chart as struck through and eliminated', () => {
    const lines = buildDrawStatusLines(
      { draw, protects: [], vetoes: [{ drawIndex: 1, by: 'bob' }], deciderIndex: undefined },
      nameOf,
    );
    expect(lines.split('\n')[1]).toBe('2. ~~Song 2 SX 12~~ ❌ Vetoed by Bob');
  });

  it('marks the decider once it is determined', () => {
    const lines = buildDrawStatusLines({ draw, protects: [], vetoes: [], deciderIndex: 2 }, nameOf);
    expect(lines.split('\n')[2]).toBe('3. Song 3 SX 12 ⭐ Decider');
  });

  it('concatenates the subtitle onto the label with a space', () => {
    const withSubtitle = [{ ...chart(1), subtitle: '(a variant)' }, chart(2)];
    const lines = buildDrawStatusLines({ draw: withSubtitle, protects: [], vetoes: [], deciderIndex: undefined }, nameOf);
    expect(lines.split('\n')[0]).toBe('1. Song 1 (a variant) SX 12');
  });

  it('appends the warning icon for a noCmod chart, whatever its status', () => {
    const flaggedDraw = [{ ...chart(1), flags: ['noCmod' as const] }, chart(2)];
    const lines = buildDrawStatusLines(
      { draw: flaggedDraw, protects: [{ drawIndex: 0, by: 'alice' }], vetoes: [], deciderIndex: undefined },
      nameOf,
    );
    expect(lines.split('\n')[0]).toBe('1. Song 1 SX 12 ⚠️ 🛡️ Protected by Alice');
  });

  it('a vetoed chart takes priority over any other marker on the same index', () => {
    const lines = buildDrawStatusLines(
      { draw, protects: [{ drawIndex: 0, by: 'alice' }], vetoes: [{ drawIndex: 0, by: 'bob' }], deciderIndex: undefined },
      nameOf,
    );
    // Can't actually happen per the rules (one action per index), but the
    // precedence should still be deterministic rather than accidental.
    expect(lines.split('\n')[0]).toContain('Vetoed');
  });
});
