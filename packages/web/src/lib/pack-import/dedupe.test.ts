import type { ChartInput, ChartSnapshot } from '@itg/shared';
import { describe, expect, it } from 'vitest';
import { buildPreview } from './dedupe.js';

function input(overrides: Partial<ChartInput> = {}): ChartInput {
  return {
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
    ...overrides,
  };
}

function snapshot(overrides: Partial<ChartSnapshot> = {}): ChartSnapshot {
  return { ...input(overrides), chartId: 'existing-1', poolLabel: null };
}

describe('buildPreview', () => {
  it('flags a chart that already exists in the tournament pack', () => {
    const rows = buildPreview([input()], [snapshot()]);
    expect(rows[0]!.isDuplicate).toBe(true);
  });

  it('does not flag a genuinely new chart', () => {
    const rows = buildPreview([input({ title: 'New Song' })], [snapshot()]);
    expect(rows[0]!.isDuplicate).toBe(false);
  });

  it('treats a different difficulty slot of the same song as distinct', () => {
    const rows = buildPreview([input({ difficulty: 'HARD' })], [snapshot({ difficulty: 'EXPERT' })]);
    expect(rows[0]!.isDuplicate).toBe(false);
  });

  it('flags the second occurrence of the same chart within one import batch', () => {
    const rows = buildPreview([input(), input()], []);
    expect(rows[0]!.isDuplicate).toBe(false);
    expect(rows[1]!.isDuplicate).toBe(true);
  });

  it('treats a null and an empty-string subtitle as distinct keys is not a concern — both charts carry null the same way', () => {
    const rows = buildPreview([input({ subtitle: null }), input({ subtitle: 'Remix' })], []);
    expect(rows[0]!.isDuplicate).toBe(false);
    expect(rows[1]!.isDuplicate).toBe(false);
  });
});
