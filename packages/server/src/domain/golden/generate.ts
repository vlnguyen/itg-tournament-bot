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
import { FORMAT_SONG_LABELS } from '@itg/shared';
import { Bo3ProtectVetoFormat, Bo3ProtectVetoFormatV2 } from '../bo3.js';
import { Bo5ProtectVetoFormat as F, Bo5ProtectVetoFormatV2 } from '../bo5.js';
import { Hb11StaticPoolFormat, Hb13StaticPoolFormat } from '../hubert.js';
import { MatchDriver, makePack, makeStaticPool } from '../testkit.js';
import type { EntrantId, MatchFormat } from '../types.js';
import type { GoldenFixture } from './types.js';

const A = 'alice';
const B = 'bob';
const REF = 'referee-casey';
const B3 = Bo3ProtectVetoFormat;
const F2 = Bo5ProtectVetoFormatV2;
const B3V2 = Bo3ProtectVetoFormatV2;
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Submits distinct EX values per player for the live song, then agrees the given winner (or a tie) — same idiom as `hubert.test.ts`'s `playCustom`. */
function playCustom(d: MatchDriver, x: EntrantId, y: EntrantId, exX: number, exY: number, winner: EntrantId | 'TIE') {
  let p = d.pending;
  if (p.kind !== 'SUBMIT_SCORE') throw new Error(`expected SUBMIT_SCORE, got ${p.kind}`);
  const songIndex = p.songIndex;
  for (const [id, ex] of [[x, exX], [y, exY]] as const) {
    d.apply({ actorId: id, type: 'SCORE_SUBMITTED', payload: { songIndex, by: id, ex } });
    d.apply({ actorId: null, type: 'PHOTO_OBSERVED', payload: { songIndex, by: id, messageId: `m-${songIndex}-${id}` } });
  }
  p = d.pending;
  if (p.kind !== 'SELECT_WINNER') throw new Error(`expected SELECT_WINNER, got ${p.kind}`);
  for (const id of [x, y]) {
    d.apply({ actorId: id, type: 'SONG_WINNER_SELECTED', payload: { songIndex, by: id, choice: winner } });
  }
}

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

// --- bo5-protect-veto-v2 / bo3-protect-veto-v2 ------------------------------
// Same two representative scenarios as the v1 corpus above, minus the
// trailing `confirmResult()` — `-v2` decides the set the instant `setWinner`
// resolves, with no separate confirmation step. See `protect-veto.ts`'s
// `autoComplete`.

// A straightforward 3-0 sweep, auto-completing on the last song's agreement.
{
  const d = new MatchDriver(makePack(20), F2).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A).playSong(A);
  fixtures.push(toFixture('v2-straight-sweep', d, F2));
}

// A 2-2 split forces the Decider, which auto-completes the set on landing.
{
  const d = new MatchDriver(makePack(20), F2).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(B).playSong(A).playSong(B).playSong(A);
  fixtures.push(toFixture('v2-decider-used', d, F2));
}

// Bo3: a clean 2-0 sweep, auto-completing on the last song's agreement.
{
  const d = new MatchDriver(makePack(20), B3V2).create(A, B).chooseSeed('FIRST').runProtectVeto();
  d.playSong(A).playSong(A);
  fixtures.push(toFixture('bo3-v2-straight-sweep', d, B3V2));
}

// --- hb11-static-pool / hb13-static-pool ------------------------------------
// Hubert's formats aren't deployed yet, so this rules change (and its
// win-condition tracking) ships in place under the existing keys — no `-v2`,
// no fixtures to preserve from before. See DESIGN.md, "Format versioning and
// golden replay", and the plan that shipped this change.

const hb11Pool = () => makeStaticPool(FORMAT_SONG_LABELS['hb11-static-pool']!);
const hb13Pool = () => makeStaticPool(FORMAT_SONG_LABELS['hb13-static-pool']!);

// HB-11: A wins three straight picks — decided outright on points, no forced
// Tiebreaker song touched.
{
  const d = new MatchDriver(hb11Pool(), Hb11StaticPoolFormat).create(A, B).runProtectVeto();
  d.pickSong().playSong(A).pickSong().playSong(A).pickSong().playSong(A);
  fixtures.push(toFixture('hb11-race-to-3', d, Hb11StaticPoolFormat));
}

// HB-11: A takes one pick, the rest of the non-TB pool ties out, and the
// forced Tiebreaker song also ties — the 1-0 record from the one decisive
// song settles it once nothing is left to play.
{
  const d = new MatchDriver(hb11Pool(), Hb11StaticPoolFormat).create(A, B).runProtectVeto();
  d.pickSong().playSong(A);
  for (let i = 0; i < 7; i++) d.pickSong().playSong('TIE');
  d.playSong('TIE'); // the forced TB song
  fixtures.push(toFixture('hb11-tiebreaker-points', d, Hb11StaticPoolFormat));
}

// HB-11: points reach 2-2 and stay tied through the forced Tiebreaker song —
// average EX% across every song played breaks it.
{
  const d = new MatchDriver(hb11Pool(), Hb11StaticPoolFormat).create(A, B).runProtectVeto();
  d.pickSong();
  playCustom(d, A, B, 95, 80, A); // 1-0
  d.pickSong();
  playCustom(d, A, B, 85, 95, B); // 1-1
  d.pickSong();
  playCustom(d, A, B, 96, 82, A); // 2-1
  d.pickSong();
  playCustom(d, A, B, 84, 96, B); // 2-2 -> TB forced
  playCustom(d, A, B, 90, 90, 'TIE'); // TB ties; avg(A)=90, avg(B)=88.6
  fixtures.push(toFixture('hb11-avg-ex-tiebreak', d, Hb11StaticPoolFormat));
}

// HB-11: points and average EX both come out fully tied — no rule left to
// apply short of a referee, who names the winner directly.
{
  const d = new MatchDriver(hb11Pool(), Hb11StaticPoolFormat).create(A, B).runProtectVeto();
  d.pickSong();
  playCustom(d, A, B, 90, 90, A); // 1-0
  d.pickSong();
  playCustom(d, A, B, 90, 90, B); // 1-1
  d.pickSong();
  playCustom(d, A, B, 90, 90, A); // 2-1
  d.pickSong();
  playCustom(d, A, B, 90, 90, B); // 2-2 -> TB forced
  playCustom(d, A, B, 90, 90, 'TIE'); // TB ties; EX identical throughout
  d.apply({ actorId: REF, type: 'SET_RESULT_RULED', payload: { result: A } });
  fixtures.push(toFixture('hb11-fully-tied-ruling', d, Hb11StaticPoolFormat));
}

// HB-13: the same race-to-3 shape, over the category-restricted veto
// sequence — confirms the rules change applies identically regardless of
// `vetoSequence`/`drawSize`.
{
  const d = new MatchDriver(hb13Pool(), Hb13StaticPoolFormat).create(A, B).runProtectVeto();
  d.pickSong().playSong(A).pickSong().playSong(A).pickSong().playSong(A);
  fixtures.push(toFixture('hb13-race-to-3', d, Hb13StaticPoolFormat));
}

for (const fixture of fixtures) {
  const path = join(FIXTURES_DIR, `${fixture.name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
