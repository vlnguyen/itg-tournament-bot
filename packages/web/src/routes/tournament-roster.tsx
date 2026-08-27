import type { Roster, RosterEntrant } from '@itg/shared';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionIcon, Alert, Badge, Center, Group, Loader, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import type { NumberInputHandlers } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useRealtimeRoster } from '../hooks/use-realtime-roster.js';
import { useRoster } from '../hooks/use-roster.js';
import { ApiError, submitSeeding } from '../lib/api.js';

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

function DragHandleIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
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
 * One roster row, sortable via `@dnd-kit/sortable`. The drag handle sits
 * to the left of the seed field — not spanning the whole row — so
 * clicking into the number input or its stepper buttons never gets
 * mistaken for the start of a drag gesture. `touchAction: 'none'` on the
 * handle is dnd-kit's own requirement, not decorative: without it a touch
 * drag fights the browser's default scroll gesture.
 */
function RosterRow({
  entry,
  max,
  onMove,
}: {
  entry: RosterEntrant;
  max: number;
  onMove: (entrantId: string, newSeed: number) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.entrantId });
  const label = entrantLabel(entry);

  return (
    <Table.Tr
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            style={{ touchAction: 'none', cursor: 'grab' }}
            aria-label={`Drag to reorder ${label}`}
            {...attributes}
            {...listeners}
          >
            <DragHandleIcon />
          </ActionIcon>
          {entry.seed !== null ? (
            <SeedInput seed={entry.seed} max={max} label={`seed for ${label}`} onMove={(v) => onMove(entry.entrantId, v)} />
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Group>
      </Table.Td>
      <Table.Td>{label}</Table.Td>
      <Table.Td>
        <Badge variant="light" color={entry.checkedIn ? 'green' : 'gray'}>
          {entry.checkedIn ? 'Checked in' : 'Not checked in'}
        </Badge>
      </Table.Td>
    </Table.Tr>
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
 * Three ways to move someone, one underlying operation: drag, the typed
 * seed number, or its stepper buttons all compute a full reordering of the
 * whole roster and submit it as one array — there's only one mutation
 * path, `reorderSeeds`, same as the server-side comment says. The mutation
 * updates optimistically so a drag settles exactly where it was dropped
 * instead of snapping back and then jumping once the request resolves;
 * `onError` rolls it back.
 *
 * `@dnd-kit` rather than native HTML5 drag-and-drop: the point of this
 * change is showing the *other* rows sliding into their would-land
 * positions live, during the drag — that live preview is dnd-kit's whole
 * reason to exist, not something worth re-deriving by hand. The typed
 * seed number stays the accessible/precise path regardless (DESIGN.md,
 * "The Organizer Console" is best-effort here, not WCAG-gated), so drag
 * only ever needs to cover "small adjustments" — dnd-kit's keyboard sensor
 * comes along for free either way.
 *
 * The typed-number/stepper path deliberately has no animation of its own —
 * an earlier hand-rolled FLIP transition there fought with dnd-kit's own
 * transform/transition on the same rows (both animating `transform` on the
 * same element from two independent systems), so that row just re-sorts
 * instantly once the optimistic update lands. Only a drag gesture animates.
 */
export default function TournamentRoster(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: roster, isPending, error } = useRoster(tournamentId!);
  useRealtimeRoster(tournamentId!);
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const mutation = useMutation({
    mutationFn: (order: string[]) => submitSeeding(tournamentId!, order),
    onMutate: async (order) => {
      await queryClient.cancelQueries({ queryKey: ['roster', tournamentId] });
      const previous = queryClient.getQueryData<Roster>(['roster', tournamentId]);
      if (previous) {
        const byId = new Map(previous.map((e) => [e.entrantId, e]));
        queryClient.setQueryData<Roster>(
          ['roster', tournamentId],
          order.map((id, i) => ({ ...byId.get(id)!, seed: i + 1 })),
        );
      }
      return { previous };
    },
    onError: (_err, _order, context) => {
      if (context?.previous) queryClient.setQueryData(['roster', tournamentId], context.previous);
    },
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
    const ids = entries.map((e) => e.entrantId);

    const submitOrder = (order: string[]): void => {
      if (order.length > 0) mutation.mutate(order);
    };

    const moveTo = (entrantId: string, newSeed: number): void => {
      const from = ids.indexOf(entrantId);
      if (from === -1) return;
      const clamped = Math.max(1, Math.min(entries.length, Math.round(newSeed)));
      const order = [...ids];
      order.splice(from, 1);
      order.splice(clamped - 1, 0, entrantId);
      submitOrder(order);
    };

    const handleDragEnd = (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = ids.indexOf(active.id as string);
      const to = ids.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      submitOrder(arrayMove(ids, from, to));
    };

    content = (
      <>
        <Title order={2}>Seeding ({entries.length})</Title>

        {mutation.isError && (
          <Alert color="red" title="Couldn't save that order">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
          </Alert>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Seed</Table.Th>
                <Table.Th>Player</Table.Th>
                <Table.Th>Check-in</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {entries.map((e) => (
                  <RosterRow key={e.entrantId} entry={e} max={entries.length} onMove={moveTo} />
                ))}
              </SortableContext>
            </Table.Tbody>
          </Table>
        </DndContext>
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
