import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyState } from '../types.js';
import { formatRegistry } from './registry.js';
import type { GoldenFixture } from './types.js';

/**
 * The golden replay corpus. See DESIGN.md, "Format versioning and golden
 * replay": "a corpus of archived event logs is replayed in CI, and every
 * committed song result, set result, and final placement must come out
 * identical. A change that breaks the corpus is a rules change by
 * definition and needs a new key; a change that does not is a bug fix and
 * may ship in place."
 *
 * Each fixture's `events` array is the frozen artifact. This test folds it
 * fresh, through whatever `bo5.ts` currently does, and compares against the
 * `expected` recorded when the fixture was generated. It never touches
 * `MatchDriver` or `generate.ts` — replay must not depend on the tool that
 * built the corpus, only on the format the fixture says it ran under.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const fixtures: GoldenFixture[] = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as GoldenFixture);

describe('golden replay corpus', () => {
  it('has at least one fixture — a corpus that silently emptied out enforces nothing', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: replays to the same committed songs and outcome`, () => {
      const format = formatRegistry[fixture.formatKey];
      if (!format) {
        throw new Error(
          `fixture "${fixture.name}" ran under formatKey "${fixture.formatKey}", which is not in formatRegistry`,
        );
      }

      const state = fixture.events.reduce((s, event) => format.reduce(s, event), emptyState());

      expect(state.songs.map((s) => ({ source: s.source, result: s.result }))).toEqual(
        fixture.expected.committedSongs,
      );
      expect(format.outcome(state)).toEqual(fixture.expected.outcome);
    });
  }
});
