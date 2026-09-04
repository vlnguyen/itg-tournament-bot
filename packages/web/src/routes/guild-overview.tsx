import { Alert, Anchor, Badge, Button, Center, Code, Group, List, Loader, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { STATE_COLOR, STATE_LABEL } from '../components/tournament-header.js';
import { ApiError, createTournamentForGuild, fetchFirstRunStatus, fetchGuildOverview } from '../lib/api.js';

/**
 * "Create" next to "Active Tournament" — the web equivalent of
 * `/tournament create`. No client-side tier gate: the server enforces
 * Tournament Organizer tier and the one-tournament-per-guild slot, and a
 * non-organizer or a guild that already holds one sees the resulting error
 * in the modal rather than a control that was never really theirs to use.
 */
function CreateTournamentButton({ guildId }: { guildId: string }): JSX.Element {
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => createTournamentForGuild(guildId, name.trim()),
    onSuccess: (tournamentId) => {
      void queryClient.invalidateQueries({ queryKey: ['guild-overview', guildId] });
      navigate(`/t/${tournamentId}/config`);
    },
  });

  const handleClose = (): void => {
    close();
    setName('');
    mutation.reset();
  };

  return (
    <>
      <Button size="xs" onClick={open}>
        Create
      </Button>
      <Modal opened={opened} onClose={handleClose} title="Create a tournament">
        <Stack>
          {mutation.isError && (
            <Alert color="red" title="Couldn't create that tournament">
              {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
            </Alert>
          )}
          <TextInput
            label="Tournament name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) mutation.mutate();
            }}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * The first-run wizard, DESIGN.md's "a view over Guild/DRAFT Tournament
 * rows, no separate wizard state" — purely a read of what `/first-run`
 * already resolved server-side, one branch per thing standing between this
 * guild and its first tournament. Only mounted once the overview query has
 * confirmed there's neither an active tournament nor any history — a guild
 * that has run one before is "set up" by definition, whatever its current
 * state, and gets the ordinary overview below instead.
 */
function FirstRunWizard({ guildId }: { guildId: string }): JSX.Element {
  const { data, isPending, isError } = useQuery({
    queryKey: ['first-run', guildId],
    queryFn: () => fetchFirstRunStatus(guildId),
  });

  // Same "nothing here yet" message a failed fetch falls back to as a
  // signed-out viewer sees on purpose — no separate error state for a
  // wizard that's already the fallback branch of the page.
  if (isPending || isError) {
    return isPending ? (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    ) : (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={2}>No tournament yet</Title>
          <Text c="dimmed">This server hasn't run a tournament yet.</Text>
        </Stack>
      </Center>
    );
  }

  // Signed out, or signed in with neither Manage Guild nor Tournament
  // Organizer tier here — nothing for this viewer to act on, so this reads
  // identically to the plain "nothing here yet" message rather than
  // hinting that there might be a draft they can't see.
  if (!data.canManage) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={2}>No tournament yet</Title>
          <Text c="dimmed">This server hasn't run a tournament yet.</Text>
        </Stack>
      </Center>
    );
  }

  if (data.draftTournamentId) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={2}>Continue setting up</Title>
          <Text c="dimmed">There's a tournament in draft. Pick up where you left off.</Text>
          <Anchor component={Link} to={`/t/${data.draftTournamentId}/config`}>
            Go to tournament configuration
          </Anchor>
        </Stack>
      </Center>
    );
  }

  if (data.missingConfig.length > 0) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Title order={2}>This server isn't set up yet</Title>
          <Text c="dimmed">
            Run <Code>/setup</Code> in Discord, or{' '}
            <Anchor component={Link} to={`/g/${guildId}/setup`}>
              configure it here
            </Anchor>
            , to set up:
          </Text>
          <List size="sm">
            {data.missingConfig.map((item) => (
              <List.Item key={item}>{item}</List.Item>
            ))}
          </List>
        </Stack>
      </Center>
    );
  }

  return (
    <Center h="60vh">
      <Stack align="center" gap="xs">
        <Title order={2}>Ready for a tournament</Title>
        <Text c="dimmed">
          The server is configured. Run <Code>/tournament create</Code> in Discord to start one.
        </Text>
      </Stack>
    </Center>
  );
}

/**
 * `/g/:guildId` — the server's own page, not a redirect into one
 * tournament. An "Active Tournament" section, a tournament history table,
 * or (a guild with neither) the first-run wizard in their place — per the
 * intended future structure, this is where a server's row on the homepage
 * server list will eventually link.
 */
export default function GuildOverview(): JSX.Element {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isPending, isError } = useQuery({
    queryKey: ['guild-overview', guildId],
    queryFn: () => fetchGuildOverview(guildId!),
    enabled: Boolean(guildId),
  });
  // `GuildOverview` itself never surfaces a `DRAFT` tournament — it's
  // public, unauthenticated. Whoever can create a tournament here should
  // still see the one already in draft instead of a plain "nothing
  // running," the same privileged reveal `FirstRunWizard` already makes;
  // `canManage`/`draftTournamentId` are `null`-safe for anyone else.
  const { data: firstRun } = useQuery({
    queryKey: ['first-run', guildId],
    queryFn: () => fetchFirstRunStatus(guildId!),
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

  const nav = (
    <Group justify="flex-end" gap="md">
      <Anchor component={Link} to={`/g/${guildId}/dashboard`} size="sm">
        Dashboard
      </Anchor>
      {firstRun?.hasManageGuild && (
        <Anchor component={Link} to={`/g/${guildId}/setup`} size="sm">
          Server Settings
        </Anchor>
      )}
    </Group>
  );

  if (!data.activeTournament && data.history.length === 0) {
    return (
      <Stack gap="xl" p="md">
        {nav}
        <FirstRunWizard guildId={guildId!} />
      </Stack>
    );
  }

  return (
    <Stack gap="xl" p="md">
      {nav}

      <div>
        <Group gap="sm" mb="xs">
          <Title order={2} size="h3">
            Active Tournament
          </Title>
          {!data.activeTournament && !firstRun?.draftTournamentId && <CreateTournamentButton guildId={guildId!} />}
        </Group>
        {data.activeTournament ? (
          <Group gap="xs">
            <Anchor component={Link} to={`/t/${data.activeTournament.id}`} fw={600}>
              {data.activeTournament.name}
            </Anchor>
            <Badge {...(STATE_COLOR[data.activeTournament.state] ? { color: STATE_COLOR[data.activeTournament.state] } : {})}>
              {STATE_LABEL[data.activeTournament.state]}
            </Badge>
          </Group>
        ) : firstRun?.draftTournamentId ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tournament</Table.Th>
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>
                  <Anchor component={Link} to={`/t/${firstRun.draftTournamentId}/config`}>
                    {firstRun.draftTournamentName}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Badge {...(STATE_COLOR.DRAFT ? { color: STATE_COLOR.DRAFT } : {})}>{STATE_LABEL.DRAFT}</Badge>
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">Nothing running.</Text>
        )}
      </div>

      <div>
        <Title order={2} size="h3" mb="xs">
          Tournament History
        </Title>
        {data.history.length === 0 ? (
          <Text c="dimmed">No past tournaments yet.</Text>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tournament</Table.Th>
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.history.map((t) => (
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
    </Stack>
  );
}
