import { Center, Loader, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router-dom';
import { fetchLandingTournament } from '../lib/api.js';

/**
 * "A server's landing page redirects to whichever tournament is currently
 * active, or to the most recent one when nothing is running." See
 * DESIGN.md, "Permanent URLs".
 */
export default function GuildLanding(): JSX.Element {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isPending, isError } = useQuery({
    queryKey: ['landing-tournament', guildId],
    queryFn: () => fetchLandingTournament(guildId!),
    enabled: Boolean(guildId),
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
        <Stack align="center" gap="xs">
          <Title order={2}>Couldn't load this server</Title>
          <Text c="dimmed">Try again in a moment.</Text>
        </Stack>
      </Center>
    );
  }

  if (data.tournamentId) return <Navigate to={`/t/${data.tournamentId}`} replace />;

  return (
    <Center h="60vh">
      <Stack align="center" gap="xs">
        <Title order={2}>No tournament yet</Title>
        <Text c="dimmed">This server hasn't run a tournament yet.</Text>
      </Stack>
    </Center>
  );
}
