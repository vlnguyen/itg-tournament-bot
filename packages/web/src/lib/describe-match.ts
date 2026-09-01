import type { ProjectedSlot } from './bracket-layout.js';
import type { BracketMatch } from '@itg/shared';

/**
 * "Because the requirement forbids conveying state by colour alone, each
 * state needs a text or icon cue: pending, in progress, awaiting
 * organizer, complete, walkover." See DESIGN.md, "What a bracket cell
 * shows". `awaitingTo` is checked first — an open escalation is still
 * `IN_PROGRESS` by `status` alone, but it's the state that actually needs
 * someone's attention.
 */
export function matchStateLabel(m: Pick<BracketMatch, 'status' | 'awaitingTo' | 'outcomeBy'>): string {
  if (m.awaitingTo) return 'Awaiting organizer';
  if (m.status === 'COMPLETE') return m.outcomeBy === 'WALKOVER' ? 'Walkover' : 'Complete';
  if (m.status === 'IN_PROGRESS') return 'In progress';
  return 'Pending';
}

/**
 * The full accessible label for one bracket cell — everything a sighted
 * reader gets from the cell's layout, read linearly. Pure so the actual
 * wording is testable without rendering anything.
 */
export function describeMatch(m: BracketMatch, projected?: [ProjectedSlot | undefined, ProjectedSlot | undefined] | undefined): string {
  const state = matchStateLabel(m);
  const [p0, p1] = m.participants;

  // A bye — one slot was never real, not merely unfilled yet. Distinct from
  // the pending "not yet determined" case below: this one seat's occupant
  // is final and never played a score, so nothing here mirrors an ordinary
  // versus line — see `match-cell.tsx`'s own bye handling.
  if (m.status === 'COMPLETE' && m.outcomeBy === 'WALKOVER' && (!p0 || !p1)) {
    const p = p0 ?? p1!;
    return `seed ${p.seed} ${p.displayName} receives a bye. ${state}.`;
  }

  if (!p0 || !p1) {
    // Mirrors `match-cell.tsx`'s dimmed/italic slots: the same seed-order
    // preview a sighted organizer sees, read out the same way — "projected"
    // is the one word doing the work of that visual styling.
    if (m.status === 'PENDING' && projected && (projected[0] || projected[1])) {
      const label = (slot: ProjectedSlot | undefined): string =>
        slot?.kind === 'entrant' ? `seed ${slot.seed} ${slot.displayName} projected` : slot?.kind === 'bye' ? 'a bye' : 'not yet determined';
      return `${label(projected[0])}, versus ${label(projected[1])}. ${state}.`;
    }
    return `${state}, not yet determined.`;
  }

  // Mirrors `match-cell.tsx`'s own `dqd`: a DQ or a mid-tournament walkover
  // (both seats real, one already withdrawn — see `engine.ts`'s
  // `startSeatedMatch`) leaves the absent side's points reading like a
  // played 0 rather than an absence.
  const nameOf = (p: (typeof m.participants)[number]): string => {
    const dqd = (m.outcomeBy === 'DQ' || m.outcomeBy === 'WALKOVER') && m.winnerId !== null && m.winnerId !== p.entrantId;
    const score = dqd ? 'DQ' : (m.points[p.entrantId] ?? 0);
    const winner = m.winnerId === p.entrantId ? ', winner' : '';
    return `seed ${p.seed} ${p.displayName}, ${score}${winner}`;
  };

  return `${nameOf(p0)}, versus ${nameOf(p1)}. ${state}.`;
}
