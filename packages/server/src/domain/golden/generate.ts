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
import { Bo5ProtectVetoFormat as F } from '../bo5.js';
import { MatchDriver, makePack } from '../testkit.js';
import type { GoldenFixture } from './types.js';

const A = 'alice';
const B = 'bob';
const REF = 'referee-casey';
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function toFixture(name: string, driver: MatchDriver): GoldenFixture {
  return {
    name,
    formatKey: F.key,
    events: driver.events,
    expected: {
      committedSongs: driver.state.songs.map((s) => ({ source: s.source, result: s.result })),
      outcome: F.outcome(driver.state),
    },
  };
}

const fixtures: GoldenFixture[] = [];

// A straightforward 3-0 sweep — no ties, no escalations, nothing but
// agreement. The baseline every other fixture varies from.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('straight-sweep', d));
}

// Song 1 ties, so there is no loser to hand their own protect to. Play
// falls through to protect order rather than the loser-protect rule —
// the distinction DESIGN.md calls out as needing its own clause.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong('TIE').playSong(A).playSong(A).playSong(A).confirmResult();
  fixtures.push(toFixture('tie-falls-through-to-protect-order', d));
}

// A 2-2 split after four songs forces the fifth to be the Decider — the
// one chart neither player protected or vetoed.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(B).playSong(A).playSong(B);
  fixtures.push(toFixture('decider-used', d));
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
  fixtures.push(toFixture('tiebreak-round', d));
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
  fixtures.push(toFixture('referee-ruling-on-disagreement', d));
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
  fixtures.push(toFixture('settings-violation-void', d));
}

// A referee ends the match early with a forfeit, after one song has
// already been played and counts toward the record.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(B);
  d.apply({ actorId: REF, type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
  fixtures.push(toFixture('forfeit-ends-set', d));
}

// A match-scope DQ ends the match as an ordinary loss, preserving points
// already won.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A);
  d.apply({ actorId: REF, type: 'DQ_APPLIED', payload: { playerId: B, scope: 'MATCH' } });
  fixtures.push(toFixture('dq-match-scope', d));
}

// The players disagree on who won the set, not any one song — a referee
// names the actual winner, same shape as a song-level disagreement one
// level up.
{
  const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).playSong(A);
  d.confirmResult({ [A]: A, [B]: B });
  d.ruleSetResult(A);
  fixtures.push(toFixture('set-result-disagreement', d));
}

// A round-1 bye: no Draw, no Protect/Veto, no play at all.
{
  const d = new MatchDriver(makePack(20)).create(A, B);
  d.apply({ actorId: null, type: 'WALKOVER', payload: { winnerId: A } });
  fixtures.push(toFixture('walkover-bye', d));
}

for (const fixture of fixtures) {
  const path = join(FIXTURES_DIR, `${fixture.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
