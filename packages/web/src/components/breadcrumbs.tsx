import { Anchor, Group, Skeleton, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useMatches } from 'react-router-dom';
import { fetchGuildOverview, fetchTournament } from '../lib/api.js';

/**
 * The header's back-navigation trail: match → tournament → guild → home.
 * Home is always the logo next to this, so this only ever renders the
 * middle links. Driven by the deepest route match's own params rather
 * than route-by-route wiring — every guild-, tournament-, or match-scoped
 * page is a flat `/g/:guildId...`/`/t/:tournamentId...` path, so there's
 * exactly one match to read params from.
 *
 * Tournament pages reuse `['tournament', tournamentId]`, the same query
 * every tournament page already makes (`useTournament`) — `guildId`/
 * `guildName` ride along on that snapshot for free. Guild-only pages
 * (`/g/:guildId`, its setup/dashboard, player pages) reuse
 * `['guild-overview', guildId]` the same way — a second fetch only on
 * the pages that don't already make it themselves (setup, player pages).
 */
export function HeaderBreadcrumbs(): JSX.Element | null {
  const matches = useMatches();
  const params = (matches[matches.length - 1]?.params ?? {}) as Record<string, string | undefined>;
  const tournamentId = params['tournamentId'];
  const matchId = params['matchId'];
  const guildId = params['guildId'];

  const { data: tournament } = useQuery({
    queryKey: ['tournament', tournamentId],
    queryFn: () => fetchTournament(tournamentId!),
    enabled: Boolean(tournamentId),
  });
  const { data: overview } = useQuery({
    queryKey: ['guild-overview', guildId],
    queryFn: () => fetchGuildOverview(guildId!),
    enabled: Boolean(guildId) && !tournamentId,
  });

  if (tournamentId) {
    if (!tournament) return <Skeleton height={16} width={160} />;
    return (
      <Group gap={6} wrap="nowrap" component="nav" aria-label="Breadcrumb" style={{ minWidth: 0 }}>
        <Anchor component={Link} to={`/g/${tournament.guildId}`} size="sm" c="dimmed" truncate>
          {tournament.guildName}
        </Anchor>
        <Text size="sm" c="dimmed">
          /
        </Text>
        <Anchor component={Link} to={`/t/${tournamentId}`} size="sm" c="dimmed" truncate>
          {tournament.name}
        </Anchor>
        {matchId && (
          <>
            <Text size="sm" c="dimmed">
              /
            </Text>
            <Anchor component={Link} to={`/t/${tournamentId}/matches/${matchId}`} size="sm" fw={600} truncate>
              Match
            </Anchor>
          </>
        )}
      </Group>
    );
  }

  if (guildId) {
    if (!overview) return <Skeleton height={16} width={100} />;
    return (
      <Group gap={6} wrap="nowrap" component="nav" aria-label="Breadcrumb" style={{ minWidth: 0 }}>
        <Anchor component={Link} to={`/g/${guildId}`} size="sm" c="dimmed" truncate>
          {overview.guildName}
        </Anchor>
      </Group>
    );
  }

  return null;
}
