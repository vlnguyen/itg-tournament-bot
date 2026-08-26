import type { RosterEntrant } from '@itg/shared';
import { Alert, Badge, Center, Loader, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useRoster } from '../hooks/use-roster.js';
import { ApiError, submitSeeding } from '../lib/api.js';

/**
 * DESIGN.md, "Seeding": "The roster is the seeding interface — one ordered
 * list... Two ways to move someone, one underlying operation." Both the
 * drag handle and the typed seed number below compute a full reordering of
 * the checked-in group and submit it as one array — there's only one
 * mutation path, `reorderSeeds`, same as the server-side comment says.
 *
 * Native HTML5 drag-and-drop rather than a drag library: this is a single
 * reorderable list on a desktop-first, best-effort-accessibility surface
 * (DESIGN.md, "The Organizer Console") — the typed seed number is the
 * accessible/precise path regardless, so drag only needs to cover "small
 * adjustments," which the native API handles without a new dependency.
 */
export default function TournamentRoster(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: roster, isPending, error } = useRoster(tournamentId!);
  const queryClient = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (order: string[]) => submitSeeding(tournamentId!, order),
    onSuccess: (updated) => queryClient.setQueryData(['roster', tournamentId], updated),
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
          Seeding needs a Discord sign-in so the server knows which tournaments you can act on.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 403) {
    content = (
      <Center h="60vh">
        <Alert color="yellow" title="Tournament Organizer tier required">
          You need Tournament Organizer tier in this server to manage seeding.
        </Alert>
      </Center>
    );
  } else if (error) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load the roster">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    // Server-ordered already — seed asc (nulls last, for anyone checked in
    // before a seed was ever assigned), then join order within a tie.
    const seeded = roster.filter((e) => e.checkedIn);
    const unseeded = roster.filter((e) => !e.checkedIn);

    const submitOrder = (order: string[]): void => {
      if (order.length > 0) mutation.mutate(order);
    };

    const moveTo = (entrantId: string, newSeed: number): void => {
      const ids = seeded.map((e) => e.entrantId);
      const from = ids.indexOf(entrantId);
      if (from === -1) return;
      const clamped = Math.max(1, Math.min(seeded.length, Math.round(newSeed)));
      ids.splice(from, 1);
      ids.splice(clamped - 1, 0, entrantId);
      submitOrder(ids);
    };

    const handleDrop = (targetId: string): void => {
      if (!dragId || dragId === targetId) {
        setDragId(null);
        return;
      }
      const ids = seeded.map((e) => e.entrantId);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from === -1 || to === -1) {
        setDragId(null);
        return;
      }
      ids.splice(from, 1);
      ids.splice(to, 0, dragId);
      setDragId(null);
      submitOrder(ids);
    };

    content = (
      <>
        <Title order={2}>Seeding</Title>

        {mutation.isError && (
          <Alert color="red" title="Couldn't save that order">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
          </Alert>
        )}

        <div>
          <Title order={2} size="h3" mb="xs">
            Checked in ({seeded.length})
          </Title>
          {seeded.length === 0 ? (
            <Text c="dimmed">Nobody has checked in yet.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Seed</Table.Th>
                  <Table.Th>Player</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {seeded.map((e) => (
                  <Table.Tr
                    key={e.entrantId}
                    draggable
                    onDragStart={() => setDragId(e.entrantId)}
                    onDragOver={(ev) => ev.preventDefault()}
                    onDrop={() => handleDrop(e.entrantId)}
                    style={{ cursor: 'grab', opacity: dragId === e.entrantId ? 0.5 : 1 }}
                  >
                    <Table.Td>
                      <NumberInput
                        size="xs"
                        w={70}
                        min={1}
                        max={seeded.length}
                        value={e.seed ?? ''}
                        onChange={(v) => typeof v === 'number' && v !== e.seed && moveTo(e.entrantId, v)}
                        aria-label={`Seed for ${entrantLabel(e)}`}
                      />
                    </Table.Td>
                    <Table.Td>{entrantLabel(e)}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        ⠿ drag to reorder
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </div>

        <div>
          <Title order={2} size="h3" mb="xs">
            Not checked in ({unseeded.length})
          </Title>
          {unseeded.length === 0 ? (
            <Text c="dimmed">Everyone on the roster has checked in.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Player</Table.Th>
                  <Table.Th>Would land at</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {unseeded.map((e, i) => (
                  <Table.Tr key={e.entrantId}>
                    <Table.Td>{entrantLabel(e)}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="gray">
                        #{seeded.length + i + 1}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
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

function entrantLabel(e: RosterEntrant): string {
  return e.displayName ?? e.discordUserId;
}
