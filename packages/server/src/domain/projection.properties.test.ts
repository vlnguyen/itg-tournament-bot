import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Bo5ProtectVetoFormat as F } from './bo5.js';
import { toPublicMatch } from './projection.js';
import { MatchDriver, makePack } from './testkit.js';
import type { EntrantId } from './types.js';

const A = 'alice';
const B = 'bob';

const arbChoices = fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 8, maxLength: 40 });
const arbPackSize = fc.integer({ min: 1, max: 30 });

/**
 * "For any event sequence, the serialized projection must not contain the
 * chart ID of an unrevealed choice." See DESIGN.md, "Public Projections and
 * Hidden State". Drives a match through every reachable state and checks
 * `toPublicMatch`'s output directly at every tiebreak step, rather than
 * scanning `MatchState` (already covered by `bo5.properties.test.ts`'s
 * "hidden state" property) — this is what actually guards a browser, an API
 * response, or a websocket frame, and a leak here is the one that matters.
 */
describe('toPublicMatch hides an unrevealed tiebreak choice', () => {
  it('chosenBy only, until both have picked — then the full reveal', () => {
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
            const first = p.actors[0]!;
            d.apply({
              actorId: first,
              type: 'TIEBREAK_CHOICE',
              payload: { round: p.round, by: first, index: pick(p.choices) },
            });

            const round = toPublicMatch(F, d.state).tiebreaks.find((t) => t.round === p.round)!;
            if (p.actors.length > 1) {
              // One pick landed, one still owed — nothing beyond who acted.
              expect(round.chosenBy).toEqual([first]);
              expect('choices' in round).toBe(false);
              expect('resolvedIndex' in round).toBe(false);
              expect(JSON.stringify(round)).not.toMatch(/"choices"|"resolvedIndex"/);
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

  it('reveals both picks and the resolved chart once the second lands', () => {
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
            for (const actorId of [...p.actors]) {
              d.apply({
                actorId,
                type: 'TIEBREAK_CHOICE',
                payload: { round: p.round, by: actorId, index: pick(p.choices) },
              });
            }
            const round = toPublicMatch(F, d.state).tiebreaks.find((t) => t.round === p.round)!;
            expect(round.chosenBy.sort()).toEqual([...p.actors].sort());
            expect('choices' in round).toBe(true);
            expect('resolvedIndex' in round).toBe(true);
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
