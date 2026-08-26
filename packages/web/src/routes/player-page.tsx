import { Alert, Badge, Center, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchPlayerPage } from '../lib/api.js';

/**
 * `/g/:guildId/players/:discordUserId` — DESIGN.md, "Player pages": keyed
 * on the user id, scoped to the server. Nothing here needs `noindex` on
 * the client side — the API response already carries `X-Robots-Tag`, and
 * that's the header search engines actually read.
 */
export default function PlayerPage(): JSX.Element {
  const { guildId, discordUserId } = useParams<{ guildId: string; discordUserId: string }>();
  const { data: page, isPending, isError } = useQuery({
    queryKey: ['player', guildId, discordUserId],
    queryFn: () => fetchPlayerPage(guildId!, discordUserId!),
  });

  if (isPending) {
    return (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  }

  if (isError) {
    return (
      <Center h="60vh">
        <Alert color="red" title="No record here">
          This player hasn't competed in this server.
        </Alert>
      </Center>
    );
  }

  return (
    <Stack gap="lg" p="md">
      <div>
        <Title order={1}>{page.currentDisplayName}</Title>
        <Group gap="xs">
          <Badge color="green">{page.wins}W</Badge>
          <Badge color="red">{page.losses}L</Badge>
        </Group>
      </div>

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
          {page.matches.map((m) => (
            <Table.Tr key={m.matchId}>
              <Table.Td>{m.tournamentName}</Table.Td>
              <Table.Td>
                {m.bracket === 'WINNERS' ? 'W' : m.bracket === 'LOSERS' ? 'L' : 'GF'}
                {m.round}
              </Table.Td>
              <Table.Td>{m.opponentDisplayName ?? '—'}</Table.Td>
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
    </Stack>
  );
}
