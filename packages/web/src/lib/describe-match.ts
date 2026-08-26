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
export function describeMatch(m: BracketMatch): string {
  const state = matchStateLabel(m);
  const [p0, p1] = m.participants;
  if (!p0 || !p1) return `${state}, not yet determined.`;

  const nameOf = (p: (typeof m.participants)[number]): string => {
    const points = m.points[p.entrantId] ?? 0;
    const winner = m.winnerId === p.entrantId ? ', winner' : '';
    return `seed ${p.seed} ${p.displayName}, ${points}${winner}`;
  };

  return `${nameOf(p0)}, versus ${nameOf(p1)}. ${state}.`;
}
