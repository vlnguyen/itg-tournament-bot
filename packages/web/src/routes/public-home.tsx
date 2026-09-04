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
 * One server card. Bot-present ones link straight to `/g/:guildId`; ones
 * the bot hasn't joined open a confirmation before handing off to
 * Discord's own invite/consent screen, since a click here is otherwise
 * indistinguishable from any other server link on the page, and the
 * target is a real, consequential grant on Discord's side, not a page
 * within this app. Shared by both homepage lists — every organizer-only
 * card is bot-present by construction, so only the manage list ever hits
 * the invite branch.
 */
function GuildCard({ guild, onRequestInvite }: { guild: GuildSummary; onRequestInvite: (guild: GuildSummary) => void }): JSX.Element {
  return guild.botPresent ? (
    <Card component={Link} to={`/g/${guild.id}`} withBorder padding="lg" className={styles.card!}>
      <Card.Section inheritPadding py="md">
        <Stack align="center" gap="xs">
          <Avatar src={guild.iconUrl} name={guild.name} color="initials" size="lg" />
          <Text fw={600} ta="center">
            {guild.name}
          </Text>
        </Stack>
      </Card.Section>
    </Card>
  ) : (
    <Card component="button" type="button" onClick={() => onRequestInvite(guild)} withBorder padding="lg" className={styles.card!}>
      <Card.Section inheritPadding py="md">
        <Stack align="center" gap="xs">
          <Avatar src={guild.iconUrl} name={guild.name} color="initials" size="lg" />
          <Text fw={600} ta="center">
            {guild.name}
          </Text>
          <Badge variant="light">Add to server</Badge>
        </Stack>
      </Card.Section>
    </Card>
  );
}

/**
 * `/` — the public landing page. Signed out, it's just a welcome and a
 * sign-in link: nothing here requires an account. Signed in, it shows two
 * lists from `fetchMyGuilds`: "Servers You Manage" — every Discord server
 * this user holds Manage Guild in, resolved from the `guilds` OAuth2 scope
 * (see `DiscordGuildsService`), including ones the bot has never been
 * added to — and "Servers You TO," every server the bot's own membership
 * cache shows this user holding the Tournament Organizer role in, aside
 * from ones already in the first list (see `TierService.
 * organizerOnlyGuildsFor`). The second list can only ever include servers
 * the bot has already joined, since TO role membership isn't visible any
 * other way; it's hidden entirely when empty.
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
  const managed = guilds?.managed ?? [];
  const organizerOnly = guilds?.organizerOnly ?? [];

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
  } else if (managed.length === 0 && organizerOnly.length === 0) {
    content = (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={1}>ITG Tournament Bot</Title>
          <Text c="dimmed">You don't manage or organize a tournament in any Discord server.</Text>
        </Stack>
      </Center>
    );
  } else {
    content = (
      <Stack gap="xl">
        {managed.length > 0 && (
          <Stack gap="lg">
            <Title order={1}>Servers You Manage</Title>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
              {managed.map((g) => (
                <GuildCard key={g.id} guild={g} onRequestInvite={requestInvite} />
              ))}
            </SimpleGrid>
          </Stack>
        )}
        {organizerOnly.length > 0 && (
          <Stack gap="lg">
            <Title order={1}>Servers You TO</Title>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
              {organizerOnly.map((g) => (
                <GuildCard key={g.id} guild={g} onRequestInvite={requestInvite} />
              ))}
            </SimpleGrid>
          </Stack>
        )}
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
