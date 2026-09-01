import type { ProjectedSlot } from '../lib/bracket-layout.js';
import type { TournamentSnapshotMatch } from '@itg/shared';
import { FORMAT_SHORT_LABEL } from '@itg/shared';
import { Checkbox, Group, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { describeMatch, matchStateLabel } from '../lib/describe-match.js';
import styles from './match-cell.module.css';

/**
 * One bracket cell: "both participants, the running score as songs
 * commit... and the match state," per DESIGN.md, "What a bracket cell
 * shows." State is never colour-only — `.stateLabel` is real text, and the
 * whole cell also carries an `aria-label` reading the same content
 * linearly for a screen reader, since the visual two-row layout doesn't
 * read in a meaningful order on its own.
 *
 * `selection` is organizer-only bracket-editing state, passed from
 * `TournamentBracket` — a signed-out or non-organizer viewer never sees the
 * checkbox at all, same policy `referee-overrides.tsx` documents: the
 * control is either fully present or fully absent, never present-but-disabled.
 */
export function MatchCell({
  tournamentId,
  entry,
  selection,
  projected,
}: {
  tournamentId: string;
  entry: TournamentSnapshotMatch;
  selection?: { checked: boolean; onToggle: () => void } | undefined;
  /**
   * Round-1 only, organizer-only (see `projectRoundOne`) — what the current
   * seed order would seat here, shown only while the real seat is still
   * empty. Once the match actually seats (or resolves as a bye), the real
   * `participants` data below takes over and this is never consulted again.
   */
  projected?: [ProjectedSlot | undefined, ProjectedSlot | undefined] | undefined;
}): JSX.Element {
  const { match } = entry;
  const [p0, p1] = match.participants;
  const label = matchStateLabel(match);
  // A bye — one slot was never real, not merely unfilled yet. See
  // `bracket-service.ts`'s `materializeBracket`: a bye seats only the real
  // side and resolves the match as a `WALKOVER` at generation time, so no
  // score was ever played and the empty seat will never fill.
  const bye = match.status === 'COMPLETE' && match.outcomeBy === 'WALKOVER' && (!p0 || !p1);
  const accessibleLabel = describeMatch(match, projected);

  return (
    <li className={styles.cell} data-status={match.status} data-awaiting={match.awaitingTo}>
      <div className={styles.cellInner}>
        {selection && (
          <Checkbox
            className={styles.select!}
            size="xs"
            checked={selection.checked}
            onChange={selection.onToggle}
            aria-label={`Select ${accessibleLabel} for format assignment`}
          />
        )}
        <Link to={`/t/${tournamentId}/matches/${entry.id}`} className={styles.link} aria-label={accessibleLabel}>
          <Stack gap={2} aria-hidden="true">
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text component="span" className={styles.stateLabel!}>
                {label}
              </Text>
              <Text component="span" className={styles.stateLabel!}>
                {FORMAT_SHORT_LABEL[match.formatKey]}
              </Text>
            </Group>
            {[p0, p1].map((p, i) => {
              // Both a genuine DQ and a mid-tournament walkover (both seats
              // real, but one entrant had already withdrawn when this match
              // went to start — see `engine.ts`'s `startSeatedMatch`) leave
              // the absent side with a 0 that looks like a played result.
              // `bye` is excluded: that 0 belongs to a seat that never
              // existed, already blanked out below.
              const dqd = p && !bye && (match.outcomeBy === 'DQ' || match.outcomeBy === 'WALKOVER') && match.winnerId !== null && match.winnerId !== p.entrantId;
              // A projection only ever fills a seat that's still genuinely
              // empty — once byes/seating run, `p` is set (or the match is
              // `COMPLETE`, handled by `bye` above) and this is ignored.
              const slotProjection = !p && !bye && match.status === 'PENDING' ? projected?.[i] : undefined;
              const projectedEntrant = slotProjection?.kind === 'entrant' ? slotProjection : undefined;
              const slotText = p
                ? `#${p.seed} ${p.displayName}`
                : bye || slotProjection?.kind === 'bye'
                  ? 'BYE'
                  : projectedEntrant
                    ? `#${projectedEntrant.seed} ${projectedEntrant.displayName}`
                    : 'TBD';
              return (
                <Group key={i} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" truncate {...(projectedEntrant ? { c: 'dimmed' as const, fs: 'italic' as const } : {})} className={p && match.winnerId === p.entrantId ? styles.winner! : ''}>
                    {slotText}
                  </Text>
                  <Text size="sm">{bye ? '' : p ? (dqd ? 'DQ' : (match.points[p.entrantId] ?? 0)) : ''}</Text>
                </Group>
              );
            })}
          </Stack>
        </Link>
      </div>
    </li>
  );
}
