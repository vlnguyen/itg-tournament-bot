import type { ChannelSlot, SetupStatus, TierRoleSlot } from '@itg/shared';
import { Alert, Anchor, Button, Center, Loader, Select, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { ApiError, fetchSetupStatus, submitSetupChannels, submitSetupRepair, submitSetupRoles } from '../lib/api.js';

/** The synthetic "make me one" option in a slot's picker — never implied by leaving the field blank, only ever this explicit choice. */
const CREATE = 'CREATE';

const CHANNEL_SLOTS: { slot: ChannelSlot; label: string; hint: string; creatable: boolean }[] = [
  { slot: 'matches', label: 'Matches', hint: 'Where match threads are created.', creatable: true },
  { slot: 'alerts', label: 'Organizer alerts', hint: 'Where escalations and organizer log lines post.', creatable: true },
  { slot: 'results', label: 'Results', hint: 'Where match results and standings post.', creatable: true },
  { slot: 'general', label: 'General', hint: 'Where tournament-wide announcements post (point at an existing channel).', creatable: false },
];

const ROLE_SLOTS: { slot: TierRoleSlot; label: string; hint: string; creatable: boolean }[] = [
  { slot: 'referee', label: 'Referee', hint: 'Can rule on disputed matches.', creatable: true },
  { slot: 'organizer', label: 'Tournament Organizer', hint: 'Can run the tournament lifecycle.', creatable: true },
];

type Selection<Slot extends string> = Partial<Record<Slot, string | null>>;

/**
 * Only the slots the viewer explicitly touched — clearing a picker (or
 * never touching it) is a strict no-op, omitted from the request entirely,
 * never implied to mean "create one." The one explicit way to create
 * something is picking the "Create automatically" option, which lands
 * here as the literal `'CREATE'` a touched-but-empty slot never does.
 */
function toRequest<Slot extends string>(selection: Selection<Slot>): Partial<Record<Slot, string>> {
  const body: Partial<Record<Slot, string>> = {};
  for (const [slot, value] of Object.entries(selection) as [Slot, string | null | undefined][]) {
    if (value) body[slot] = value;
  }
  return body;
}

/**
 * The web console's server-reconfiguration panel, DESIGN.md's "the one
 * panel outside [the tier] filter... gated on Manage Guild the same way
 * `/setup` is." Mirrors `/setup` exactly: point-at-existing or
 * create-for-me for four channel slots and two tier roles, the live
 * permission diagnostic, and Repair — same `discord/setup-effects.ts`
 * logic behind both surfaces, so a binding made here and one made with
 * `/setup channels` are indistinguishable in effect.
 */
export default function GuildSetup(): JSX.Element {
  const { guildId } = useParams<{ guildId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data, isPending, error } = useQuery({
    queryKey: ['setup', guildId],
    queryFn: () => fetchSetupStatus(guildId!),
    enabled: Boolean(guildId),
  });
  const queryClient = useQueryClient();

  const [channels, setChannels] = useState<Selection<ChannelSlot>>({});
  const [roles, setRoles] = useState<Selection<TierRoleSlot>>({});

  // Re-seed the form from the server's current bindings whenever they
  // change — first load, or after a save/repair refetches this query.
  // Split in two, each keyed on only its own four/two binding values —
  // not `data.bindings` as a whole, which gets a new object identity on
  // *every* fetch, including the other form's save. Saving Roles must not
  // stomp on an unsaved edit sitting in the Channels form (and vice
  // versa); each form only re-seeds when its own bindings actually moved.
  useEffect(() => {
    if (!data) return;
    setChannels({ matches: data.bindings.matches, alerts: data.bindings.alerts, results: data.bindings.results, general: data.bindings.general });
  }, [data?.bindings.matches, data?.bindings.alerts, data?.bindings.results, data?.bindings.general]);

  useEffect(() => {
    if (!data) return;
    setRoles({ referee: data.bindings.referee, organizer: data.bindings.organizer });
  }, [data?.bindings.referee, data?.bindings.organizer]);

  const onSuccess = (updated: SetupStatus): void => {
    queryClient.setQueryData(['setup', guildId], updated);
  };
  const channelsMutation = useMutation({
    mutationFn: () => submitSetupChannels(guildId!, toRequest(channels)),
    onSuccess,
  });
  const rolesMutation = useMutation({
    mutationFn: () => submitSetupRoles(guildId!, toRequest(roles)),
    onSuccess,
  });
  const repairMutation = useMutation({
    mutationFn: () => submitSetupRepair(guildId!),
    onSuccess,
  });

  let content: JSX.Element;

  if (userPending || isPending) {
    content = (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  } else if (!discordUserId) {
    content = (
      <Center h="60vh">
        <Alert color="blue" title="Sign in required">
          Reconfiguring this server needs a Discord sign-in so the server knows who you are. <Anchor href="/api/auth/login">Sign in</Anchor>.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 403) {
    content = (
      <Center h="60vh">
        <Alert color="yellow" title="Manage Server required">
          You need the <strong>Manage Server</strong> permission in this server to reconfigure the bot.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 404) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Server not found">
          The bot isn't in this server (anymore).
        </Alert>
      </Center>
    );
  } else if (error || !data) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load setup status">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    const { diagnostic } = data;
    const clean =
      diagnostic.gapDescriptions.length === 0 &&
      diagnostic.missingChannels.length === 0 &&
      diagnostic.missingTierRoles.length === 0 &&
      diagnostic.deletedTierRoles.length === 0;

    content = (
      <Stack gap="xl">
        <div>
          <Anchor component={Link} to={`/g/${guildId}`} size="sm">
            ← Back to server
          </Anchor>
          <Title order={2}>Server Settings</Title>
        </div>

        <div>
          <Title order={3} size="h4" mb="xs">
            Diagnostic
          </Title>
          <Stack gap={4}>
            {diagnostic.missingTierRoles.map((slot) => (
              <Text key={`missing-${slot}`} c="red" size="sm">
                ❌ The {ROLE_SLOTS.find((r) => r.slot === slot)!.label} role is not configured.
              </Text>
            ))}
            {diagnostic.deletedTierRoles.map((slot) => (
              <Text key={`deleted-${slot}`} c="yellow" size="sm">
                ⚠️ The configured {ROLE_SLOTS.find((r) => r.slot === slot)!.label} role no longer exists. Point at a replacement below.
              </Text>
            ))}
            {diagnostic.missingChannels.map((slot) => (
              <Text key={`missing-ch-${slot}`} c="yellow" size="sm">
                ⚠️ The configured {slot} channel no longer exists. Point at a replacement below.
              </Text>
            ))}
            {clean && (
              <Text c="green" size="sm">
                ✅ Everything's ready.
              </Text>
            )}
            {diagnostic.gapDescriptions.map((desc, i) => (
              <Text key={i} size="sm">
                - {desc}
              </Text>
            ))}
            {diagnostic.refereePoolEmpty && (
              <Text c="yellow" size="sm">
                ⚠️ Nobody holds a role at Referee tier or above yet, so a dispute has nobody to rule on it.
              </Text>
            )}
          </Stack>
          {diagnostic.repairableCount > 0 && (
            <Button mt="sm" size="xs" onClick={() => repairMutation.mutate()} loading={repairMutation.isPending}>
              Repair {diagnostic.repairableCount} overwrite(s)
            </Button>
          )}
          {repairMutation.data && repairMutation.data.notes.length > 0 && (
            <Text size="sm" c="dimmed" mt="xs">
              {repairMutation.data.notes.join(' ')}
            </Text>
          )}
        </div>

        <div>
          <Title order={3} size="h4" mb="xs">
            Channels
          </Title>
          <Stack gap="sm" maw={480}>
            {CHANNEL_SLOTS.map(({ slot, label, hint, creatable }) => (
              <Select
                key={slot}
                label={label}
                description={hint}
                placeholder="Not configured"
                data={[
                  ...(creatable ? [{ value: CREATE, label: 'Create automatically' }] : []),
                  ...data.channels.map((c) => ({ value: c.id, label: `#${c.name}` })),
                ]}
                value={channels[slot] ?? null}
                onChange={(value) => setChannels((prev) => ({ ...prev, [slot]: value }))}
                searchable
                clearable
              />
            ))}
          </Stack>
          {channelsMutation.isError && (
            <Alert color="red" mt="sm" title="Couldn't save channels">
              {channelsMutation.error instanceof ApiError ? channelsMutation.error.message : 'Something went wrong.'}
            </Alert>
          )}
          {channelsMutation.data && channelsMutation.data.notes.length > 0 && (
            <Text size="sm" c="dimmed" mt="sm">
              {channelsMutation.data.notes.join(' ')}
            </Text>
          )}
          <Button mt="sm" onClick={() => channelsMutation.mutate()} loading={channelsMutation.isPending}>
            Save Channels
          </Button>
        </div>

        <div>
          <Title order={3} size="h4" mb="xs">
            Roles
          </Title>
          <Stack gap="sm" maw={480}>
            {ROLE_SLOTS.map(({ slot, label, hint, creatable }) => (
              <Select
                key={slot}
                label={label}
                description={hint}
                placeholder="Not configured"
                data={[
                  ...(creatable ? [{ value: CREATE, label: 'Create automatically' }] : []),
                  ...data.roles.map((r) => ({ value: r.id, label: r.name })),
                ]}
                value={roles[slot] ?? null}
                onChange={(value) => setRoles((prev) => ({ ...prev, [slot]: value }))}
                searchable
                clearable
              />
            ))}
          </Stack>
          {rolesMutation.isError && (
            <Alert color="red" mt="sm" title="Couldn't save roles">
              {rolesMutation.error instanceof ApiError ? rolesMutation.error.message : 'Something went wrong.'}
            </Alert>
          )}
          {rolesMutation.data && rolesMutation.data.notes.length > 0 && (
            <Text size="sm" c="dimmed" mt="sm">
              {rolesMutation.data.notes.join(' ')}
            </Text>
          )}
          <Button mt="sm" onClick={() => rolesMutation.mutate()} loading={rolesMutation.isPending}>
            Save Roles
          </Button>
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
