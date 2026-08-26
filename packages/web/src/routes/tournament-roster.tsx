import type { RosterEntrant } from '@itg/shared';
import { ActionIcon, Alert, Badge, Center, Group, Loader, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import type { NumberInputHandlers } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useRealtimeRoster } from '../hooks/use-realtime-roster.js';
import { useRoster } from '../hooks/use-roster.js';
import { ApiError, submitSeeding } from '../lib/api.js';

/**
 * FLIP (First-Last-Invert-Play), the standard technique for animating a
 * reflow without a library: React has already committed the reordered rows
 * to the DOM by the time a layout effect runs, so there's nothing to
 * "animate to" — only a *previous* position to animate *from*. Each run
 * compares every row's current top against what was recorded last time;
 * a row whose top moved plays a translateY from the old delta back to
 * zero, which reads as the row sliding into its new spot. Rows whose
 * order didn't change record the same position and animate nothing.
 *
 * `prefers-reduced-motion` is honored by skipping the animation outright —
 * the row still ends up in the right place instantly, motion is just not
 * how that gets confirmed.
 */
function useRowReorderAnimation(orderKey: string, rows: { current: Map<string, HTMLTableRowElement> }): void {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previous = positions.current;
    const next = new Map<string, number>();
    for (const [id, row] of rows.current) {
      const top = row.getBoundingClientRect().top;
      next.set(id, top);
      const prevTop = previous.get(id);
      if (!reduceMotion && prevTop !== undefined && prevTop !== top) {
        row.animate([{ transform: `translateY(${prevTop - top}px)` }, { transform: 'translateY(0)' }], {
          duration: 120,
          easing: 'ease-out',
        });
      }
    }
    positions.current = next;
  }, [orderKey]);
}

/** Plain inline SVG rather than an icon-library dependency — same reasoning as `layout.tsx`'s `HomeIcon`. */
function ChevronUpIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * A seed is a position in a list sorted ascending, so moving *down* the
 * list means the number has to go *up* — Mantine's default stepper (chevron
 * up increments, chevron down decrements) points the opposite way from the
 * row it moves. `hideControls` drops the native pair and this renders its
 * own with `handlersRef`, swapped: up moves the row up (decrement), down
 * moves it down (increment). Typing a number directly is unaffected —
 * only the stepper buttons' direction changes.
 */
function SeedInput({
  seed,
  max,
  label,
  onMove,
}: {
  seed: number;
  max: number;
  label: string;
  onMove: (newSeed: number) => void;
}): JSX.Element {
  const handlers = useRef<NumberInputHandlers>(null);
  return (
    <NumberInput
      size="xs"
      w={70}
      min={1}
      max={max}
      value={seed}
      onChange={(v) => typeof v === 'number' && v !== seed && onMove(v)}
      aria-label={label}
      hideControls
      withKeyboardEvents={false}
      handlersRef={handlers}
      rightSection={
        <Stack gap={0}>
          <ActionIcon
            size={14}
            variant="subtle"
            color="gray"
            aria-label={`Move ${label} up`}
            disabled={seed <= 1}
            onClick={() => handlers.current?.decrement()}
          >
            <ChevronUpIcon />
          </ActionIcon>
          <ActionIcon
            size={14}
            variant="subtle"
            color="gray"
            aria-label={`Move ${label} down`}
            disabled={seed >= max}
            onClick={() => handlers.current?.increment()}
          >
            <ChevronDownIcon />
          </ActionIcon>
        </Stack>
      }
      rightSectionWidth={20}
    />
  );
}

/**
 * DESIGN.md, "Seeding": "The roster is the seeding interface — one ordered
 * list, with each entrant's check-in state" — a single list, check-in as
 * its own column, not a grouping split. Every active entrant already holds
 * a seed from the moment they join, so there is no separate "not seeded
 * yet" group to show; check-in and seeding are independent right up until
 * the tournament starts, which is when non-checked-in entrants are dropped
 * and the survivors' seeds collapse to 1..N.
 *
 * Both the drag handle and the typed seed number below compute a full
 * reordering of the whole roster and submit it as one array — there's only
 * one mutation path, `reorderSeeds`, same as the server-side comment says.
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
  useRealtimeRoster(tournamentId!);
  const queryClient = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  useRowReorderAnimation(roster ? roster.map((e) => e.entrantId).join(',') : '', rowRefs);

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
  } else if (roster.length === 0) {
    content = (
      <>
        <Title order={2}>Seeding</Title>
        <Text c="dimmed">Nobody has joined yet.</Text>
      </>
    );
  } else {
    // Server-ordered already — seed asc (nulls last, for data predating
    // seed-at-join), then join order within a tie.
    const entries = roster;

    const submitOrder = (order: string[]): void => {
      if (order.length > 0) mutation.mutate(order);
    };

    const moveTo = (entrantId: string, newSeed: number): void => {
      const ids = entries.map((e) => e.entrantId);
      const from = ids.indexOf(entrantId);
      if (from === -1) return;
      const clamped = Math.max(1, Math.min(entries.length, Math.round(newSeed)));
      ids.splice(from, 1);
      ids.splice(clamped - 1, 0, entrantId);
      submitOrder(ids);
    };

    const handleDrop = (targetId: string): void => {
      if (!dragId || dragId === targetId) {
        setDragId(null);
        return;
      }
      const ids = entries.map((e) => e.entrantId);
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
        <Title order={2}>Seeding ({entries.length})</Title>

        {mutation.isError && (
          <Alert color="red" title="Couldn't save that order">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
          </Alert>
        )}

        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Seed</Table.Th>
              <Table.Th>Player</Table.Th>
              <Table.Th>Check-in</Table.Th>
              <Table.Th></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((e) => (
              <Table.Tr
                key={e.entrantId}
                ref={(el) => {
                  if (el) rowRefs.current.set(e.entrantId, el);
                  else rowRefs.current.delete(e.entrantId);
                }}
                draggable
                onDragStart={() => setDragId(e.entrantId)}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={() => handleDrop(e.entrantId)}
                style={{ cursor: 'grab', opacity: dragId === e.entrantId ? 0.5 : 1 }}
              >
                <Table.Td>
                  {e.seed !== null ? (
                    <SeedInput seed={e.seed} max={entries.length} label={`seed for ${entrantLabel(e)}`} onMove={(v) => moveTo(e.entrantId, v)} />
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{entrantLabel(e)}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={e.checkedIn ? 'green' : 'gray'}>
                    {e.checkedIn ? 'Checked in' : 'Not checked in'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      ⠿
                    </Text>
                    <Text size="xs" c="dimmed" visibleFrom="sm">
                      drag to reorder
                    </Text>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
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
