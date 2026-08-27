import { Alert, Anchor, Badge, Center, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { ApiError, fetchGuildOverview, fetchPlayerPage } from '../lib/api.js';

/**
 * `/g/:guildId/dashboard` — DESIGN.md, "The dashboard": "a link straight
 * into your live match thread, your standing in the running tournament,
 * and your past events in this server." An assembled view of already-
 * public data (`fetchGuildOverview`, `fetchPlayerPage`) — "sign-in adds
 * convenience and never capability" — plus one small addition
 * (`PlayerPage.liveMatch`) for the live-match link, which nothing else in
 * the app surfaces yet even though it's no less public than the rest.
 *
 * "Standing in the running tournament" is a win/loss tally for that one
 * tournament, not a bracket-position indicator — the same `matches[]`
 * `fetchPlayerPage` already returns, just filtered down to the active
 * tournament's id.
 */
export default function GuildDashboard(): JSX.Element {
  const { guildId } = useParams<{ guildId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: overview, isPending: overviewPending } = useQuery({
    queryKey: ['guild-overview', guildId],
    queryFn: () => fetchGuildOverview(guildId!),
    enabled: Boolean(guildId),
  });
  const {
    data: page,
    isPending: pagePending,
    error: pageError,
  } = useQuery({
    queryKey: ['player', guildId, discordUserId],
    queryFn: () => fetchPlayerPage(guildId!, discordUserId!),
    enabled: Boolean(guildId && discordUserId),
  });

  let content: JSX.Element;

  if (userPending) {
    content = (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  } else if (!discordUserId) {
    content = (
      <Center h="60vh">
        <Alert color="blue" title="Sign in required">
          The dashboard needs a Discord sign-in so it knows who you are. <Anchor href="/api/auth/login">Sign in</Anchor>.
        </Alert>
      </Center>
    );
  } else if (overviewPending || pagePending) {
    content = (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  } else if (pageError && !(pageError instanceof ApiError && pageError.status === 404)) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load your dashboard">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    // A 404 here just means this player has never competed in this
    // server — not an error, the same "nothing here yet" a brand new
    // account sees, distinct from a real fetch failure above.
    const matches = page?.matches ?? [];
    const activeTournament = overview?.activeTournament ?? null;
    const currentTournamentMatches = activeTournament ? matches.filter((m) => m.tournamentId === activeTournament.id) : [];
    const currentWins = currentTournamentMatches.filter((m) => m.won).length;
    const currentLosses = currentTournamentMatches.length - currentWins;

    content = (
      <Stack gap="xl">
        <Title order={2}>Dashboard</Title>

        {page?.liveMatch && (
          <Alert color="blue" title="You have a live match">
            <Anchor component={Link} to={`/t/${page.liveMatch.tournamentId}/matches/${page.liveMatch.matchId}`}>
              Go to your match in {page.liveMatch.tournamentName}
            </Anchor>
          </Alert>
        )}

        {activeTournament && (
          <div>
            <Title order={3} size="h4" mb="xs">
              Current Tournament
            </Title>
            <Group gap="xs">
              <Anchor component={Link} to={`/t/${activeTournament.id}`} fw={600}>
                {activeTournament.name}
              </Anchor>
              {currentTournamentMatches.length > 0 ? (
                <Group gap={4}>
                  <Badge color="green">{currentWins}W</Badge>
                  <Badge color="red">{currentLosses}L</Badge>
                </Group>
              ) : (
                <Text c="dimmed" size="sm">
                  No decided matches yet.
                </Text>
              )}
            </Group>
          </div>
        )}

        <div>
          <Title order={3} size="h4" mb="xs">
            Past Events
          </Title>
          {matches.length === 0 ? (
            <Text c="dimmed">Nothing here yet.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tournament</Table.Th>
                  <Table.Th>Round</Table.Th>
                  <Table.Th>Opponent</Table.Th>
                  <Table.Th>Score</Table.Th>
                  <Table.Th>Result</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {matches.map((m) => (
                  <Table.Tr key={m.matchId}>
                    <Table.Td>{m.tournamentName}</Table.Td>
                    <Table.Td>
                      {m.bracket === 'WINNERS' ? 'W' : m.bracket === 'LOSERS' ? 'L' : 'GF'}
                      {m.round}
                    </Table.Td>
                    {/* `null` only ever means this was a bye — every real, seated opponent always has a name. */}
                    <Table.Td>{m.opponentDisplayName ?? 'BYE'}</Table.Td>
                    <Table.Td>
                      {m.points}–{m.opponentPoints}
                    </Table.Td>
                    <Table.Td>
                      <Link to={`/t/${m.tournamentId}/matches/${m.matchId}`}>{m.won ? 'Won' : 'Lost'}</Link>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </div>
      </Stack>
    );
  }

  return (
    <Stack gap="xl" p="md">
      {content}
    </Stack>
  );
}
