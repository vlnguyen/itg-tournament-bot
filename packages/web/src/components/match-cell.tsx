import type { TournamentSnapshotMatch } from '@itg/shared';
import { Group, Stack, Text } from '@mantine/core';
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
 */
export function MatchCell({ tournamentId, entry }: { tournamentId: string; entry: TournamentSnapshotMatch }): JSX.Element {
  const { match } = entry;
  const [p0, p1] = match.participants;
  const label = matchStateLabel(match);
  // A bye — one slot was never real, not merely unfilled yet. See
  // `bracket-service.ts`'s `materializeBracket`: a bye seats only the real
  // side and resolves the match as a `WALKOVER` at generation time, so no
  // score was ever played and the empty seat will never fill.
  const bye = match.status === 'COMPLETE' && match.outcomeBy === 'WALKOVER' && (!p0 || !p1);

  return (
    <li className={styles.cell} data-status={match.status} data-awaiting={match.awaitingTo}>
      <Link to={`/t/${tournamentId}/matches/${entry.id}`} className={styles.link} aria-label={describeMatch(match)}>
        <Stack gap={2} aria-hidden="true">
          <Text component="span" className={styles.stateLabel!}>
            {label}
          </Text>
          {[p0, p1].map((p, i) => {
            // Both a genuine DQ and a mid-tournament walkover (both seats
            // real, but one entrant had already withdrawn when this match
            // went to start — see `engine.ts`'s `startSeatedMatch`) leave
            // the absent side with a 0 that looks like a played result.
            // `bye` is excluded: that 0 belongs to a seat that never
            // existed, already blanked out below.
            const dqd = p && !bye && (match.outcomeBy === 'DQ' || match.outcomeBy === 'WALKOVER') && match.winnerId !== null && match.winnerId !== p.entrantId;
            return (
              <Group key={i} justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm" truncate className={p && match.winnerId === p.entrantId ? styles.winner! : ''}>
                  {p ? `#${p.seed} ${p.displayName}` : bye ? 'BYE' : 'TBD'}
                </Text>
                <Text size="sm">{bye ? '' : p ? (dqd ? 'DQ' : (match.points[p.entrantId] ?? 0)) : ''}</Text>
              </Group>
            );
          })}
        </Stack>
      </Link>
    </li>
  );
}
