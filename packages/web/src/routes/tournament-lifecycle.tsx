import type { LifecycleAction, SetTournamentFormatMode } from '@itg/shared';
import { FORMAT_LABEL, FormatKey } from '@itg/shared';
import { Alert, Button, Center, Group, List, Loader, Modal, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { STATE_LABEL, TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useLifecycleStatus } from '../hooks/use-lifecycle-status.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';
import { ApiError, submitLifecycleAction } from '../lib/api.js';

const ACTION_LABEL: Record<LifecycleAction, string> = {
  OPEN_REGISTRATION: 'Open Registration',
  CLOSE_REGISTRATION: 'Close Registration',
  OPEN_CHECKIN: 'Open Check-in',
  CLOSE_CHECKIN: 'Close Check-in',
  START: 'Start Tournament',
  // Never rendered from this table — the Bracket section below has its own
  // Generate/Regenerate button (wording driven by `status.bracketEntrantCount`)
  // and is filtered out of the generic action row. The key still has to be
  // here for `Record<LifecycleAction, string>` to stay exhaustive.
  GENERATE_BRACKET: 'Generate Bracket',
  CANCEL: 'Cancel Tournament',
  RENAME: 'Rename',
};

/**
 * DESIGN.md, "Everything else": "current state, the transitions currently
 * legal, and each one's guard shown as a checklist." Start runs the same
 * `startTournamentWithDiscordEffects` `/tournament start` does — see
 * `LifecycleRequest`'s comment in `@itg/shared` — so a click here creates
 * the same threads and posts the same announcement `/tournament start`
 * would. `startGuards` still can't predict the live permission preflight
 * that call makes; a failure there comes back as this mutation's own
 * error, worded the same as the Discord command's reply.
 */
export default function TournamentLifecycle(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: status, isPending, error } = useLifecycleStatus(tournamentId!);
  useRealtimeTournament(tournamentId!);
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

  // Separate from `mutation` above: SET_FORMAT isn't a `LifecycleAction` (see
  // that type's comment in `@itg/shared`) — it takes an argument, so it's a
  // Select's onChange, not one of the one-click buttons below.
  const [conflict, setConflict] = useState<{ formatKey: FormatKey; breakdown: Record<string, number> } | null>(null);
  const formatMutation = useMutation({
    mutationFn: ({ formatKey, mode }: { formatKey: FormatKey; mode?: SetTournamentFormatMode }) =>
      submitLifecycleAction(tournamentId!, { action: 'SET_FORMAT', formatKey, mode }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['lifecycle', tournamentId], updated);
      setConflict(null);
    },
    onError: (err, variables) => {
      // Matches are mixed across formats and no mode was given — put the
      // three-way choice to the TO instead of failing outright. Any other
      // error surfaces as the plain Alert below, same as always.
      if (err instanceof ApiError && err.status === 409 && err.breakdown) {
        setConflict({ formatKey: variables.formatKey, breakdown: err.breakdown });
      }
    },
  });

  // The graph half of `materializeBracket`, pulled ahead of Start so
  // per-match formats have real matches to land on — see DESIGN.md, "Match
  // Format as a Plugin". Idempotent: calling it again regenerates.
  const bracketMutation = useMutation({
    mutationFn: () => submitLifecycleAction(tournamentId!, { action: 'GENERATE_BRACKET' }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['lifecycle', tournamentId], updated);
      // The bracket page reads the tournament snapshot, not this query.
      void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
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
      if (action === 'START' && !confirm(`Start "${status.name}"? This creates match threads and notifies players. It can't be undone from here.`)) {
        return;
      }
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
          <Group gap="xs" mb="xs">
            <Title order={2} size="h3">
              Format
            </Title>
            {formatMutation.isPending && <Loader size="xs" aria-label="Updating format" />}
          </Group>
          {formatMutation.isError && !conflict && (
            <Alert color="red" title="Couldn't do that" mb="xs">
              {formatMutation.error instanceof ApiError ? formatMutation.error.message : 'Something went wrong.'}
            </Alert>
          )}
          <Select
            maw={320}
            data={FormatKey.options.map((key) => ({ value: key, label: FORMAT_LABEL[key] }))}
            value={status.defaultFormatKey}
            disabled={!status.formatEditable || formatMutation.isPending}
            allowDeselect={false}
            onChange={(value) => value && formatMutation.mutate({ formatKey: value as FormatKey })}
          />
          {!status.formatEditable && (
            <Text size="xs" c="dimmed" mt={4}>
              Locked: the bracket is already generated under this format.
            </Text>
          )}
        </div>

        {(status.legalActions.includes('GENERATE_BRACKET') || status.bracketEntrantCount !== null) && (
          <div>
            <Title order={2} size="h3" mb="xs">
              Bracket
            </Title>
            {bracketMutation.isError && (
              <Alert color="red" title="Couldn't generate the bracket" mb="xs">
                {bracketMutation.error instanceof ApiError ? bracketMutation.error.message : 'Something went wrong.'}
              </Alert>
            )}
            <Group gap="sm" align="center">
              {status.legalActions.includes('GENERATE_BRACKET') && (
                <Button size="sm" loading={bracketMutation.isPending} onClick={() => bracketMutation.mutate()}>
                  {status.bracketEntrantCount === null ? 'Generate Bracket' : 'Regenerate Bracket'}
                </Button>
              )}
              {status.bracketEntrantCount !== null && (
                <Text size="sm" c="dimmed">
                  Built for {status.bracketEntrantCount} checked-in entrants.
                </Text>
              )}
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              Generating early lets you assign Best of 3 or Best of 5 per round or per match from the bracket page, before
              Start.
            </Text>
          </div>
        )}

        <div>
          <Title order={2} size="h3" mb="xs">
            Actions
          </Title>
          {status.legalActions.filter((a) => a !== 'GENERATE_BRACKET').length === 0 ? (
            <Text c="dimmed">Nothing to do: this tournament is {STATE_LABEL[status.state].toLowerCase()}.</Text>
          ) : (
            <Group gap="xs">
              {status.legalActions
                .filter((a) => a !== 'GENERATE_BRACKET')
                .map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'CANCEL' ? 'outline' : 'filled'}
                    {...(action === 'CANCEL' ? { color: 'red' } : {})}
                    {...(action === 'START' ? { color: 'green' } : {})}
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
            Once every check below passes, click Start above, or run <code>/tournament start</code> in Discord: either does
            the same thing. Starting also re-verifies live channel/role permissions, which this checklist can't predict in
            advance; a failure there comes back exactly the way it would in Discord.
          </Text>
          <List spacing={4} size="sm">
            {status.startGuards.map((g) => (
              <List.Item key={g.label} icon={g.ok ? '✅' : '⬜'}>
                <Text {...(g.ok ? {} : { c: 'dimmed' })}>{g.label}</Text>
              </List.Item>
            ))}
          </List>
        </div>

        <Modal opened={conflict !== null} onClose={() => setConflict(null)} title="Matches are on different formats">
          {conflict && (
            <Stack gap="sm">
              <Text size="sm">This tournament's matches aren't all on one format right now:</Text>
              <List size="sm">
                {Object.entries(conflict.breakdown).map(([key, count]) => (
                  <List.Item key={key}>
                    {FORMAT_LABEL[key as FormatKey]}: {count}
                  </List.Item>
                ))}
              </List>
              <Text size="sm">How should setting the default to {FORMAT_LABEL[conflict.formatKey]} be handled?</Text>
              <Group justify="flex-end" gap="xs">
                <Button variant="subtle" onClick={() => setConflict(null)}>
                  Cancel
                </Button>
                <Button variant="outline" onClick={() => formatMutation.mutate({ formatKey: conflict.formatKey, mode: 'DEFAULT_ONLY' })}>
                  Change the default only
                </Button>
                <Button onClick={() => formatMutation.mutate({ formatKey: conflict.formatKey, mode: 'UPDATE_ALL' })}>Update all matches</Button>
              </Group>
            </Stack>
          )}
        </Modal>
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
