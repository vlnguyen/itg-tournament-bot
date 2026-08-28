/**
 * Regenerates the golden corpus's fixture files under `fixtures/`.
 *
 * This is a generator, not a test — it is not run by CI or by `vitest run`.
 * Each fixture's *events* are the frozen artifact; `replay.test.ts` is what
 * enforces the corpus, by folding those events fresh through whatever the
 * reducer currently does and comparing against `expected`. Re-running this
 * script only makes sense when adding a fixture, or when a genuine rules
 * change ships under a new `formatKey` and needs its own corpus entry — see
 * DESIGN.md, "Format versioning and golden replay". Never re-run it to make
 * an existing fixture pass; that defeats the point of it being golden.
 *
 * Run with: npx tsx packages/server/src/domain/golden/generate.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bo3ProtectVetoFormat } from '../bo3.js';
import { Bo5ProtectVetoFormat as F } from '../bo5.js';
import { MatchDriver, makePack } from '../testkit.js';
import type { MatchFormat } from '../types.js';
import type { GoldenFixture } from './types.js';

const A = 'alice';
const B = 'bob';
const REF = 'referee-casey';
const B3 = Bo3ProtectVetoFormat;
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function toFixture(name: string, driver: MatchDriver, format: MatchFormat): GoldenFixture {
  return {
    name,
    formatKey: format.key,
    events: driver.events,
    expected: {
      committedSongs: driver.state.songs.map((s) => ({ source: s.source, result: s.result })),
      outcome: format.outcome(driver.state),
    },
  };
}

const fixtures: GoldenFixture[] = [];

// A straightforward 3-0 sweep — no ties, no escalations, nothing but
// agreement. The baseline every other fixture varies from.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('straight-sweep', d, F));
}

// Song 1 ties, so there is no loser to hand their own protect to. Play
// falls through to protect order rather than the loser-protect rule —
// the distinction DESIGN.md calls out as needing its own clause.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong('TIE').playSong(A).playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('tie-falls-through-to-protect-order', d, F));
}

// A 2-2 split after four songs forces the fifth to be the Decider — the
// one chart neither player protected or vetoed.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(B).playSong(A).playSong(B);
  fixtures.push(toFixture('decider-used', d, F));
}

// Every one of the five Draw-position songs ties, exhausting the Draw
// without anyone reaching three points — the tiebreak loop the rules do
// not guarantee will ever terminate (see DESIGN.md, "The rules do not
// guarantee termination"), here resolved in three tiebreak rounds.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong('TIE').playSong('TIE').playSong('TIE').playSong('TIE').playSong('TIE');
  d.tiebreakPick(0).playSong(A);
  d.tiebreakPick(0).playSong(A);
  d.tiebreakPick(0).playSong(A);
  d.confirmResult();
  fixtures.push(toFixture('tiebreak-round', d, F));
}

// The players disagree on song 1; a referee rules it, and play continues
// as if it had been agreed.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  for (const id of [A, B]) {
    d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex: 0, by: id, ex: 90 } });
    d.apply({
      actorId: null,
      type: 'PHOTO_OBSERVED',
      payload: { songIndex: 0, by: id, messageId: `m-${id}` },
    });
  }
  for (const id of [A, B]) {
    d.apply({
      actorId: id,
      type: 'SONG_WINNER_SELECTED',
      payload: { songIndex: 0, by: id, choice: id },
    });
  }
  d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: A } });
  d.playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('referee-ruling-on-disagreement', d, F));
}

// A settings violation voids song 1 rather than awarding it — nobody gets
// the point, and (like a tie) play falls through to protect order.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.apply({
    actorId: A,
    type: 'SONG_ESCALATED',
    payload: { songIndex: 0, reason: 'SETTINGS_VIOLATION' },
  });
  d.apply({ actorId: REF, type: 'SONG_RULED', payload: { songIndex: 0, result: 'VOID' } });
  d.playSong(A).playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('settings-violation-void', d, F));
}

// A referee ends the match early with a forfeit, after one song has
// already been played and counts toward the record.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(B);
  d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
  fixtures.push(toFixture('forfeit-ends-set', d, F));
}

// A match-scope DQ ends the match as an ordinary loss, preserving points
// already won.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A);
  d.apply({ actorId: REF, type: 'DQ_APPLIED', payload: { playerId: B, scope: 'MATCH' } });
  fixtures.push(toFixture('dq-match-scope', d, F));
}

// The players disagree on who won the set, not any one song — a referee
// names the actual winner, same shape as a song-level disagreement one
// level up.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).playSong(A);
  d.confirmResult({ [A]: A, [B]: B });
  d.ruleSetResult(A);
  fixtures.push(toFixture('set-result-disagreement', d, F));
}

// A round-1 bye: no Draw, no Protect/Veto, no play at all.
{
  const d = new MatchDriver(makePack(20)).create(A, B);
  d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });
  fixtures.push(toFixture('walkover-bye', d, F));
}

// Bo3: a clean 2-0 sweep — the Decider position is never used.
{
  const d = new MatchDriver(makePack(20), B3).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('bo3-straight-sweep', d, B3));
}

// Bo3: a 1-1 split after the two protects forces the third song to be the
// Decider — the one chart neither player protected or vetoed.
{
  const d = new MatchDriver(makePack(20), B3).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(B).playSong(A).confirmResult();
  fixtures.push(toFixture('bo3-decider-used', d, B3));
}

// Bo3: every one of the three Draw-position songs ties, exhausting the Draw
// without anyone reaching two points — resolved in the same shared tiebreak
// loop Bo5 uses, here in two rounds.
{
  const d = new MatchDriver(makePack(20), B3).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong('TIE').playSong('TIE').playSong('TIE');
  d.tiebreakPick(0).playSong(A);
  d.tiebreakPick(0).playSong(A);
  d.confirmResult();
  fixtures.push(toFixture('bo3-tiebreak-round', d, B3));
}

for (const fixture of fixtures) {
  const path = join(FIXTURES_DIR, `${fixture.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
