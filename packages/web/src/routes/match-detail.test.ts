import type { ChartSnapshot, PublicMatch } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { isStaticPool, pickedBy } from './match-detail.js';

function chart(overrides: Partial<ChartSnapshot> = {}): ChartSnapshot {
  return {
    chartId: 'c1',
    title: 'Vertex',
    titleTranslit: null,
    subtitle: null,
    subtitleTranslit: null,
    artist: null,
    artistTranslit: null,
    playStyle: 'SINGLE',
    difficulty: 'EXPERT',
    meter: 15,
    stepartist: null,
    description: null,
    sourcePack: null,
    flags: [],
    poolLabel: null,
    ...overrides,
  };
}

describe('isStaticPool', () => {
  it('is false for an empty draw', () => {
    expect(isStaticPool([])).toBe(false);
  });

  it('is false when no chart carries a poolLabel (Bo3/Bo5)', () => {
    expect(isStaticPool([chart({ chartId: 'a' }), chart({ chartId: 'b' })])).toBe(false);
  });

  it('is true when every chart carries a poolLabel (Hubert\'s formats)', () => {
    expect(isStaticPool([chart({ chartId: 'a', poolLabel: 'RD1' }), chart({ chartId: 'b', poolLabel: 'TB' })])).toBe(true);
  });

  it('is false if even one chart is missing a poolLabel — a mixed draw is not a well-formed static pool', () => {
    expect(isStaticPool([chart({ chartId: 'a', poolLabel: 'RD1' }), chart({ chartId: 'b', poolLabel: null })])).toBe(false);
  });
});

describe('pickedBy', () => {
  const pub = { picks: [{ drawIndex: 2, by: 'alice' }] } as PublicMatch;

  it("names the picker for a song that matches a pick's drawIndex", () => {
    const song = { drawIndex: 2 } as PublicMatch['songs'][number];
    expect(pickedBy(pub, song)).toBe('alice');
  });

  it('is undefined for a forced Tiebreaker or any other song with no matching pick', () => {
    const song = { drawIndex: 9 } as PublicMatch['songs'][number];
    expect(pickedBy(pub, song)).toBeUndefined();
  });

  it('is undefined when the song has no drawIndex at all', () => {
    const song = {} as PublicMatch['songs'][number];
    expect(pickedBy(pub, song)).toBeUndefined();
  });
});
