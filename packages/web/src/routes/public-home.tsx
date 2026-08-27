import type { GuildSummary } from '@itg/shared';
import { Anchor, Avatar, Badge, Button, Card, Center, Group, Loader, Modal, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { fetchMyGuilds } from '../lib/api.js';
import styles from './public-home.module.css';

/**
 * `/` — the public landing page. Signed out, it's just a welcome and a
 * sign-in link: nothing here requires an account. Signed in, it shows
 * every Discord server this user holds Manage Guild in — `fetchMyGuilds`,
 * resolved from the `guilds` OAuth2 scope (see `DiscordGuildsService`) —
 * including ones the bot has never been added to. A card for a server the
 * bot is already in links to `/g/:guildId`; one where it isn't opens a
 * confirmation before handing off to Discord's own invite/consent screen,
 * since a click here is otherwise indistinguishable from any other server
 * link on the page, and the target is a real, consequential grant on
 * Discord's side, not a page within this app.
 */
export default function PublicHome(): JSX.Element {
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: guilds, isPending: guildsPending } = useQuery({
    queryKey: ['my-guilds'],
    queryFn: fetchMyGuilds,
    enabled: Boolean(discordUserId),
  });
  const [inviteTarget, setInviteTarget] = useState<GuildSummary | null>(null);
  const [confirmOpened, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);

  function requestInvite(guild: GuildSummary): void {
    setInviteTarget(guild);
    openConfirm();
  }

  function confirmInvite(): void {
    if (inviteTarget?.inviteUrl) window.open(inviteTarget.inviteUrl, '_blank', 'noopener,noreferrer');
    closeConfirm();
  }

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
            Sign in to see the servers you manage. <Anchor href="/api/auth/login">Sign in</Anchor>.
          </Text>
        </Stack>
      </Center>
    );
  } else if (!guilds || guilds.length === 0) {
    content = (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={1}>ITG Tournament Bot</Title>
          <Text c="dimmed">You don't have Manage Server in any Discord server.</Text>
        </Stack>
      </Center>
    );
  } else {
    content = (
      <Stack gap="lg">
        <Title order={1}>Servers You Manage</Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {guilds.map((g) =>
            g.botPresent ? (
              <Card key={g.id} component={Link} to={`/g/${g.id}`} withBorder padding="lg" className={styles.card!}>
                <Card.Section inheritPadding py="md">
                  <Stack align="center" gap="xs">
                    <Avatar src={g.iconUrl} name={g.name} color="initials" size="lg" />
                    <Text fw={600} ta="center">
                      {g.name}
                    </Text>
                  </Stack>
                </Card.Section>
              </Card>
            ) : (
              <Card
                key={g.id}
                component="button"
                type="button"
                onClick={() => requestInvite(g)}
                withBorder
                padding="lg"
                className={styles.card!}
              >
                <Card.Section inheritPadding py="md">
                  <Stack align="center" gap="xs">
                    <Avatar src={g.iconUrl} name={g.name} color="initials" size="lg" />
                    <Text fw={600} ta="center">
                      {g.name}
                    </Text>
                    <Badge variant="light">Add to server</Badge>
                  </Stack>
                </Card.Section>
              </Card>
            ),
          )}
        </SimpleGrid>
      </Stack>
    );
  }

  return (
    <Stack gap="xl" p="md">
      {content}
      <Modal opened={confirmOpened} onClose={closeConfirm} title="Add ITG Tournament Bot?">
        <Stack>
          <Text size="sm">
            This opens Discord's own authorization screen to add the bot to <strong>{inviteTarget?.name}</strong>. You'll choose
            the channels and permissions there.
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button onClick={confirmInvite}>Continue to Discord</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
