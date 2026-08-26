import type { LifecycleAction } from '@itg/shared';
import { Alert, Button, Center, Group, List, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { STATE_LABEL, TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useLifecycleStatus } from '../hooks/use-lifecycle-status.js';
import { ApiError, submitLifecycleAction } from '../lib/api.js';

const ACTION_LABEL: Record<LifecycleAction, string> = {
  OPEN_REGISTRATION: 'Open Registration',
  CLOSE_REGISTRATION: 'Close Registration',
  OPEN_CHECKIN: 'Open Check-in',
  CLOSE_CHECKIN: 'Close Check-in',
  CANCEL: 'Cancel Tournament',
  RENAME: 'Rename',
};

/**
 * DESIGN.md, "Everything else": "current state, the transitions currently
 * legal, and each one's guard shown as a checklist." `START` isn't a
 * button here — see `LifecycleRequest`'s comment in `@itg/shared` for why
 * starting stays a Discord-only action for now; `startGuards` still shows
 * what's blocking it.
 */
export default function TournamentLifecycle(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: status, isPending, error } = useLifecycleStatus(tournamentId!);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  const mutation = useMutation({
    mutationFn: (action: LifecycleAction) =>
      submitLifecycleAction(tournamentId!, action === 'RENAME' ? { action, name: newName.trim() } : { action }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['lifecycle', tournamentId], updated);
      // The shared header reads the tournament snapshot query, not this
      // one — without this, a rename or a state change (cancel, open
      // registration, ...) leaves the header showing the stale name/badge
      // until something else happens to refetch it.
      void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
      setRenaming(false);
    },
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
          Tournament configuration needs a Discord sign-in so the server knows which tournaments you can act on.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 403) {
    content = (
      <Center h="60vh">
        <Alert color="yellow" title="Tournament Organizer tier required">
          You need Tournament Organizer tier in this server to configure this tournament.
        </Alert>
      </Center>
    );
  } else if (error) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load tournament configuration">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    const runAction = (action: LifecycleAction): void => {
      if (action === 'CANCEL' && !confirm(`Cancel "${status.name}"? This can't be undone from here.`)) return;
      if (action === 'RENAME') {
        setRenaming(true);
        return;
      }
      mutation.mutate(action);
    };

    content = (
      <>
        <Title order={2}>Configuration</Title>

        {mutation.isError && (
          <Alert color="red" title="Couldn't do that">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
          </Alert>
        )}

        {renaming && (
          <Group gap="xs" maw={400}>
            <TextInput
              placeholder="New name"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button size="xs" disabled={newName.trim().length === 0} onClick={() => mutation.mutate('RENAME')}>
              Save
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </Group>
        )}

        <div>
          <Title order={2} size="h3" mb="xs">
            Actions
          </Title>
          {status.legalActions.length === 0 ? (
            <Text c="dimmed">Nothing to do — this tournament is {STATE_LABEL[status.state].toLowerCase()}.</Text>
          ) : (
            <Group gap="xs">
              {status.legalActions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'CANCEL' ? 'outline' : 'filled'}
                  {...(action === 'CANCEL' ? { color: 'red' } : {})}
                  onClick={() => runAction(action)}
                >
                  {ACTION_LABEL[action]}
                </Button>
              ))}
            </Group>
          )}
        </div>

        <div>
          <Title order={2} size="h3" mb="xs">
            Starting the tournament
          </Title>
          <Text size="sm" c="dimmed" mb="xs">
            Run <code>/tournament start</code> in Discord once every check below passes — it also verifies live channel/role
            permissions, which this page can't check.
          </Text>
          <List spacing={4} size="sm">
            {status.startGuards.map((g) => (
              <List.Item key={g.label} icon={g.ok ? '✅' : '⬜'}>
                <Text {...(g.ok ? {} : { c: 'dimmed' })}>{g.label}</Text>
              </List.Item>
            ))}
          </List>
        </div>
      </>
    );
  }

  return (
    <Stack gap="xl" p="md">
      <TournamentHeader tournamentId={tournamentId!} />
      {content}
    </Stack>
  );
}
