import { Anchor, Avatar, Card, Center, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { fetchMyGuilds } from '../lib/api.js';

/**
 * `/` — the public landing page. Signed out, it's just a welcome and a
 * sign-in link: nothing here requires an account. Signed in, it shows
 * "the list of servers the user belongs to... where the bot is present"
 * — `fetchMyGuilds`, resolved bot-side with no new OAuth scope (see
 * `TierService.guildsFor`'s comment) — each one a card linking to
 * `/g/:guildId`.
 */
export default function PublicHome(): JSX.Element {
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: guilds, isPending: guildsPending } = useQuery({
    queryKey: ['my-guilds'],
    queryFn: fetchMyGuilds,
    enabled: Boolean(discordUserId),
  });

  let content: JSX.Element;

  if (userPending || (discordUserId && guildsPending)) {
    content = (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  } else if (!discordUserId) {
    content = (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={1}>ITG Tournament Bot</Title>
          <Text c="dimmed">
            Sign in to see the servers you share with the bot. <Anchor href="/api/auth/login">Sign in</Anchor>.
          </Text>
        </Stack>
      </Center>
    );
  } else if (!guilds || guilds.length === 0) {
    content = (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={1}>ITG Tournament Bot</Title>
          <Text c="dimmed">The bot isn't in any of your servers yet.</Text>
        </Stack>
      </Center>
    );
  } else {
    content = (
      <Stack gap="lg">
        <Title order={1}>Your Servers</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {guilds.map((g) => (
            <Card key={g.id} component={Link} to={`/g/${g.id}`} withBorder padding="lg">
              <Card.Section inheritPadding py="md">
                <Stack align="center" gap="xs">
                  <Avatar src={g.iconUrl} name={g.name} color="initials" size="lg" />
                  <Text fw={600} ta="center">
                    {g.name}
                  </Text>
                </Stack>
              </Card.Section>
            </Card>
          ))}
        </SimpleGrid>
      </Stack>
    );
  }

  return (
    <Stack gap="xl" p="md">
      {content}
    </Stack>
  );
}
