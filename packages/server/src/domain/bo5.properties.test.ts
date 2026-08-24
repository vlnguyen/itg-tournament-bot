import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F, POINTS_TO_WIN } from './bo5.js';
import { MatchDriver, makePack } from './testkit.js';
import { actorsOf } from './types.js';
import type { EntrantId } from './types.js';

const A = 'alice';
const B = 'bob';

/**
 * Drives a match to completion by making an arbitrary legal choice at every
 * decision point, so a generated seed explores a different path through the
 * rules each time.
 */
function playArbitrary(
  choices: readonly number[],
  packSize: number,
): { driver: MatchDriver; visited: string[] } {
  const d = new MatchDriver(makePack(packSize));
  let i = 0;
  const pick = <T>(xs: readonly T[]): T => xs[choices[i++ % choices.length]! % xs.length]!;
  const visited: string[] = [];

  d.create(A, B);
  for (let guard = 0; guard < 300; guard++) {
    const p = F.pendingAction(d.state);
    visited.push(p.kind);
    switch (p.kind) {
      case 'DONE':
        return { driver: d, visited };
      case 'SEED_CHOICE':
        d.chooseSeed(pick(['FIRST', 'SECOND'] as const));
        break;
      case 'PROTECT':
      case 'VETO':
        d.apply({
          actorId: p.actor,
          type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
          payload: { by: p.actor, drawIndex: pick(p.choices) },
        });
        break;
      case 'SUBMIT_SCORE': {
        // One tie in six: frequent enough to exercise the fall-through, rare
        // enough that the set reaches three points. See "the rules do not
        // guarantee termination" below for why an unbiased generator hangs.
        const winner = pick([A, A, A, B, B, 'TIE'] as const) as EntrantId | 'TIE';
        d.playSong(winner);
        break;
      }
      case 'SELECT_WINNER':
        throw new Error('playSong should have resolved winner selection');
      case 'TIEBREAK_PICK':
        d.tiebreakPick(pick(p.choices));
        break;
      case 'CONFIRM_RESULT':
        d.confirmResult();
        break;
      case 'AWAITING_TO':
        throw new Error('agreed selections should never escalate');
      case 'AWAITING_BOT':
        throw new Error('driver should have settled bot directives');
    }
  }
  throw new Error(`match did not finish; visited ${visited.join(' -> ')}`);
}

const arbChoices = fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 8, maxLength: 40 });
const arbPackSize = fc.integer({ min: 1, max: 30 });

describe('the rules do not guarantee termination', () => {
  /**
   * Found by a property test that assumed they did. A tie awards nothing and
   * the tiebreak repeats "until a player reaches 3 points", so a match in which
   * every song ties generates tiebreak rounds forever. That is correct per the
   * requirements rather than a defect: the bot never decides an outcome on its
   * own, and a stalled match is resolved by a referee.
   *
   * Pinned here so the behaviour is deliberate and a future termination proof
   * is not written against a false premise.
   */
  it('an all-ties match continues indefinitely and never resolves itself', () => {
    const d = new MatchDriver(makePack(20));
    d.create(A, B);
    d.chooseSeed('FIRST');
    for (;;) {
      const p = F.pendingAction(d.state);
      if (p.kind === 'PROTECT' || p.kind === 'VETO') {
        d.apply({
          actorId: p.actor,
          type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
          payload: { by: p.actor, drawIndex: p.choices[0]! },
        });
        continue;
      }
      break;
    }

    for (let i = 0; i < 25; i++) {
      const p = F.pendingAction(d.state);
      if (p.kind === 'TIEBREAK_PICK') d.tiebreakPick(0);
      else if (p.kind === 'SUBMIT_SCORE') d.playSong('TIE');
      else throw new Error(`unexpected ${p.kind}`);
    }

    // Still going, nobody has a point, and no outcome exists.
    expect(d.state.points[A]).toBe(0);
    expect(d.state.points[B]).toBe(0);
    expect(F.outcome(d.state)).toBeNull();
    expect(F.pendingAction(d.state).kind).not.toBe('DONE');
    expect(d.state.tiebreaks.length).toBeGreaterThan(5);
  });

  it('a referee can end one that has stalled', () => {
    const d = new MatchDriver(makePack(20)).create(A, B).chooseSeed('FIRST').runProtectVeto();
    d.playSong('TIE');
    d.apply({ actorId: 'ref', type: 'FORFEIT_APPLIED', payload: { winnerId: A } });
    expect(F.pendingAction(d.state)).toEqual({ kind: 'DONE' });
    expect(F.outcome(d.state)!.by).toBe('FORFEIT');
  });
});

describe('liveness', () => {
  it('every reachable state is DONE or has an actor with something to do', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const d = new MatchDriver(makePack(packSize));
        d.create(A, B);
        let i = 0;
        const pick = <T>(xs: readonly T[]): T => xs[choices[i++ % choices.length]! % xs.length]!;

        for (let guard = 0; guard < 300; guard++) {
          const p = F.pendingAction(d.state);
          if (p.kind === 'DONE') return;

          // The property: a live match always has someone who can act.
          if (p.kind === 'AWAITING_TO') {
            expect(p.reason).toBeDefined();
          } else if (p.kind !== 'AWAITING_BOT') {
            const actors = actorsOf(p);
            expect(actors.length).toBeGreaterThan(0);
            if (p.kind === 'PROTECT' || p.kind === 'VETO' || p.kind === 'TIEBREAK_PICK') {
              expect(p.choices.length).toBeGreaterThan(0);
            }
          }

          switch (p.kind) {
            case 'SEED_CHOICE':
              d.chooseSeed(pick(['FIRST', 'SECOND'] as const));
              break;
            case 'PROTECT':
            case 'VETO':
              d.apply({
                actorId: p.actor,
                type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
                payload: { by: p.actor, drawIndex: pick(p.choices) },
              });
              break;
            case 'SUBMIT_SCORE':
              d.playSong(pick([A, A, A, B, B, 'TIE'] as const) as EntrantId | 'TIE');
              break;
            case 'TIEBREAK_PICK':
              d.tiebreakPick(pick(p.choices));
              break;
            case 'CONFIRM_RESULT':
              d.confirmResult();
              break;
            default:
              throw new Error(`unexpected ${p.kind}`);
          }
        }
        throw new Error('match did not terminate');
      }),
      { numRuns: 300 },
    );
  });

  it('terminates with exactly one winner on three points, given decisive songs', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        const out = F.outcome(driver.state)!;
        expect(out).not.toBeNull();
        const firsts = out.placements.filter((p) => p.place === 1);
        expect(firsts).toHaveLength(1);
        expect(driver.state.points[firsts[0]!.entrantId]).toBe(POINTS_TO_WIN);
      }),
      { numRuns: 200 },
    );
  });
});

describe('play order', () => {
  it('the next song is always uniquely determined — never zero, never two', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        // Every song that came from the Draw consumed a distinct position, and
        // no position was played twice.
        const drawIndices = driver.state.songs
          .filter((s) => s.drawIndex !== undefined)
          .map((s) => s.drawIndex!);
        expect(new Set(drawIndices).size).toBe(drawIndices.length);
      }),
      { numRuns: 200 },
    );
  });

  it('never plays a vetoed chart', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        const vetoed = new Set(driver.state.vetoes.map((v) => v.drawIndex));
        for (const song of driver.state.songs) {
          if (song.drawIndex !== undefined) expect(vetoed.has(song.drawIndex)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('plays at most five songs from the Draw', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        const fromDraw = driver.state.songs.filter((s) => s.drawIndex !== undefined);
        expect(fromDraw.length).toBeLessThanOrEqual(5);
      }),
      { numRuns: 200 },
    );
  });
});

describe('scoring', () => {
  it('points always equal committed song wins', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        for (const id of [A, B]) {
          const wins = driver.state.songs.filter((s) => s.result?.winner === id).length;
          expect(driver.state.points[id]).toBe(wins);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never exceeds three points', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        for (const id of [A, B]) {
          expect(driver.state.points[id]).toBeLessThanOrEqual(POINTS_TO_WIN);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a tie advances nobody', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        const ties = driver.state.songs.filter(
          (s) => s.result?.winner === 'TIE' || s.result?.winner === 'VOID',
        ).length;
        const total = (driver.state.points[A] ?? 0) + (driver.state.points[B] ?? 0);
        expect(total).toBe(driver.state.songs.filter((s) => s.result).length - ties);
      }),
      { numRuns: 200 },
    );
  });
});

describe('replay', () => {
  it('folding the same events always yields the same state', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const first = playArbitrary(choices, packSize).driver.state;
        const second = playArbitrary(choices, packSize).driver.state;
        expect(second).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});

describe('hidden state', () => {
  it('a tiebreak choice is never visible before both have landed', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const d = new MatchDriver(makePack(packSize));
        d.create(A, B);
        let i = 0;
        const pick = <T>(xs: readonly T[]): T => xs[choices[i++ % choices.length]! % xs.length]!;

        for (let guard = 0; guard < 300; guard++) {
          const p = F.pendingAction(d.state);
          if (p.kind === 'DONE') return;
          if (p.kind === 'TIEBREAK_PICK') {
            // One player picks; the round must stay unresolved and the other
            // player must still be on the clock.
            const first = p.actors[0]!;
            d.apply({
              actorId: first,
              type: 'TIEBREAK_CHOICE',
              payload: { round: p.round, by: first, index: pick(p.choices) },
            });
            const round = d.state.tiebreaks.find((t) => t.round === p.round)!;
            if (p.actors.length > 1) {
              expect(round.resolvedIndex).toBeUndefined();
              expect(Object.keys(round.choices)).toHaveLength(1);
            }
            continue;
          }
          switch (p.kind) {
            case 'SEED_CHOICE':
              d.chooseSeed(pick(['FIRST', 'SECOND'] as const));
              break;
            case 'PROTECT':
            case 'VETO':
              d.apply({
                actorId: p.actor,
                type: p.kind === 'PROTECT' ? 'CHART_PROTECTED' : 'CHART_VETOED',
                payload: { by: p.actor, drawIndex: pick(p.choices) },
              });
              break;
            case 'SUBMIT_SCORE':
              d.playSong(pick([A, A, A, B, B, 'TIE'] as const) as EntrantId | 'TIE');
              break;
            case 'CONFIRM_RESULT':
              d.confirmResult();
              break;
            default:
              throw new Error(`unexpected ${p.kind}`);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});
