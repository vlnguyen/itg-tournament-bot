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

  return (
    <li className={styles.cell} data-status={match.status} data-awaiting={match.awaitingTo}>
      <Link to={`/t/${tournamentId}/matches/${entry.id}`} className={styles.link} aria-label={describeMatch(match)}>
        <Stack gap={2} aria-hidden="true">
          <Text component="span" className={styles.stateLabel!}>
            {label}
          </Text>
          {[p0, p1].map((p, i) => (
            <Group key={i} justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" truncate className={p && match.winnerId === p.entrantId ? styles.winner! : ''}>
                {p ? `#${p.seed} ${p.displayName}` : 'TBD'}
              </Text>
              <Text size="sm">{p ? (match.points[p.entrantId] ?? 0) : ''}</Text>
            </Group>
          ))}
        </Stack>
      </Link>
    </li>
  );
}
