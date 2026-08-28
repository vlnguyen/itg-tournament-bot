import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Bo3ProtectVetoFormat as F, POINTS_TO_WIN } from './bo3.js';
import { MatchDriver, makePack } from './testkit.js';
import { actorsOf } from './types.js';
import type { EntrantId } from './types.js';

/**
 * The Bo3 counterpart of `bo5.properties.test.ts`, over the shared engine
 * (`protect-veto.ts`) with Bo3's own numbers: a 5-song Draw (2 protects + 2
 * vetoes + 1 Decider), 2 points to win, and a fixed (not loser-preference)
 * play order. Kept as its own file rather than parameterizing the Bo5 suite
 * in place, so the already-passing Bo5 properties stay untouched.
 */

const A = 'alice';
const B = 'bob';

function playArbitrary(
  choices: readonly number[],
  packSize: number,
): { driver: MatchDriver; visited: string[] } {
  const d = new MatchDriver(makePack(packSize), F);
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
        // One tie in six: frequent enough to exercise the tiebreak loop, rare
        // enough that most matches reach two points on their own.
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

describe('liveness', () => {
  it('every reachable state is DONE or has an actor with something to do', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const d = new MatchDriver(makePack(packSize), F);
        d.create(A, B);
        let i = 0;
        const pick = <T>(xs: readonly T[]): T => xs[choices[i++ % choices.length]! % xs.length]!;

        for (let guard = 0; guard < 300; guard++) {
          const p = F.pendingAction(d.state);
          if (p.kind === 'DONE') return;

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

  it('terminates with exactly one winner on two points, given decisive songs', () => {
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

  it('plays at most three songs from the Draw', () => {
    fc.assert(
      fc.property(arbChoices, arbPackSize, (choices, packSize) => {
        const { driver } = playArbitrary(choices, packSize);
        const fromDraw = driver.state.songs.filter((s) => s.drawIndex !== undefined);
        expect(fromDraw.length).toBeLessThanOrEqual(3);
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

  it('never exceeds two points', () => {
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
