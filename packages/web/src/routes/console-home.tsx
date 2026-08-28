import { Alert, Anchor, Badge, Center, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { STATE_COLOR, STATE_LABEL } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { ApiError, fetchAdminGuilds } from '../lib/api.js';

/**
 * `/console` — the Bot Administrator's one extra surface, DESIGN.md's
 * "Everything else": "a list of every server the bot is in with its
 * tournaments, and nothing else. It is read-only by construction." Not the
 * organizer console itself — a Tournament Organizer's actual console lives
 * per-tournament at `/t/:id/console`, reached from that tournament's own
 * pages, since nothing about running one is cross-guild. This page only
 * exists for the one role whose whole job here *is* cross-guild.
 */
export default function ConsoleHome(): JSX.Element {
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const {
    data: guilds,
    isPending: guildsPending,
    error,
  } = useQuery({
    queryKey: ['admin-guilds'],
    queryFn: fetchAdminGuilds,
    enabled: Boolean(discordUserId),
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 403) && failureCount < 3,
  });

  if (userPending || (discordUserId && guildsPending)) {
    return (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  }

  if (!discordUserId) {
    return (
      <Center h="60vh">
        <Alert color="blue" title="Sign in required">
          This page is for bot administrators. Sign in with an administrator account to see it.
        </Alert>
      </Center>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <Center h="60vh">
        <Alert color="yellow" title="Bot administrator only">
          There's nothing here for you. A Tournament Organizer's console lives on their own tournament's pages.
        </Alert>
      </Center>
    );
  }

  if (error || !guilds) {
    return (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load the server list">
          Try again in a moment.
        </Alert>
      </Center>
    );
  }

  return (
    <Stack gap="lg" p="md">
      <Title order={1}>Servers</Title>
      {guilds.length === 0 ? (
        <Text c="dimmed">The bot isn't in any servers.</Text>
      ) : (
        guilds.map((g) => (
          <div key={g.guildId}>
            <Title order={2} size="h3" mb="xs">
              {g.guildName}
            </Title>
            {g.tournaments.length === 0 ? (
              <Text c="dimmed">No tournaments.</Text>
            ) : (
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Tournament</Table.Th>
                    <Table.Th>State</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {g.tournaments.map((t) => (
                    <Table.Tr key={t.id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/t/${t.id}`}>
                          {t.name}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <Badge {...(STATE_COLOR[t.state] ? { color: STATE_COLOR[t.state] } : {})}>{STATE_LABEL[t.state]}</Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </div>
        ))
      )}
    </Stack>
  );
}
