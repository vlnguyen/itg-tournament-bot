import type { ChartInput, ChartSnapshot, FormatKey, PoolCategory, SongPoolIssues, TournamentSnapshot } from '@itg/shared';
import {
  canEditSongPool,
  canImportPack,
  displayStepartistLine,
  displaySubtitle,
  displayTitle,
  FORMAT_SHORT_LABEL,
  FORMAT_SONG_LABELS,
  FORMAT_STATIC_SONG_POOL,
  playstylePrefix,
  poolCategoryOf,
  POOL_CATEGORY_LABEL,
} from '@itg/shared';
import type { DifficultySlot, PlayStyle, TournamentState } from '@itg/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ImportPreviousEventButton } from '../components/import-previous-event.js';
import { PackImport } from '../components/pack-import.js';
import { TournamentHeader } from '../components/tournament-header.js';
import { useLifecycleStatus } from '../hooks/use-lifecycle-status.js';
import { useTournament } from '../hooks/use-tournament.js';
import {
  ApiError,
  commitPackChanges,
  createSongPoolTab,
  deleteSongPoolTab,
  fetchCharts,
  fetchSongPools,
  saveSongPoolLabels,
} from '../lib/api.js';
import { EMPTY_FILTERS, filterCharts, packHasMixedPlayStyles, type PackFilters } from '../lib/pack-search.js';
import styles from './tournament-pack.module.css';

const DIFFICULTY_OPTIONS: { value: DifficultySlot; label: string }[] = [
  { value: 'NOVICE', label: 'Novice' },
  { value: 'EASY', label: 'Easy' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HARD', label: 'Hard' },
  { value: 'EXPERT', label: 'Expert' },
];

const PLAYSTYLE_OPTIONS: { value: PlayStyle; label: string }[] = [
  { value: 'SINGLE', label: 'Single' },
  { value: 'DOUBLE', label: 'Double' },
];

/** Plain inline SVG rather than an icon-library dependency — same reasoning as `layout.tsx`'s `HomeIcon`. */
function TrashIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Shown in place of the trash icon once a row is pending deletion — clicking it again is what restores the row, per its own click handler. */
function RestoreIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 9a8 8 0 1 1 1.5 4.7" strokeLinecap="round" />
      <path d="M4 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A tab's own "×" close control — small enough to sit inside the tab label without crowding it. */
function CloseIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
    </svg>
  );
}

const EDITABLE_FIELDS = [
  'title',
  'titleTranslit',
  'artist',
  'artistTranslit',
  'playStyle',
  'difficulty',
  'meter',
  'flags',
  'stepartist',
  'description',
] as const;

function isRowEdited(a: ChartInput, b: ChartInput): boolean {
  return EDITABLE_FIELDS.some((field) => a[field] !== b[field]);
}

/**
 * One editable row, split out and memoized so a keystroke in one row's
 * input only re-renders that row — not the whole table. This only works
 * because the parent passes stable props for everyone else: `onFieldChange`/
 * `onToggleDelete` are `useCallback`'d with no dependencies (they close
 * over state setters, not state itself), and `row` keeps its prior object
 * reference for every chart except the one just edited (the parent's
 * `setEdited` only replaces that one key). `React.memo`'s default shallow
 * prop comparison is what turns that stability into an actual skipped
 * render.
 */
const EditableChartRow = memo(function EditableChartRow({
  original,
  row,
  marked,
  onFieldChange,
  onToggleDelete,
}: {
  original: ChartSnapshot;
  row: ChartInput;
  marked: boolean;
  onFieldChange: <K extends (typeof EDITABLE_FIELDS)[number]>(chartId: string, field: K, value: ChartInput[K]) => void;
  onToggleDelete: (chartId: string) => void;
}): JSX.Element {
  const chartId = original.chartId;
  return (
    <Table.Tr style={marked ? { opacity: 0.5 } : undefined}>
      <Table.Td>
        <ActionIcon
          variant="subtle"
          color={marked ? 'blue' : 'red'}
          onClick={() => onToggleDelete(chartId)}
          aria-label={marked ? `Keep ${original.title}` : `Delete ${original.title}`}
        >
          {marked ? <RestoreIcon /> : <TrashIcon />}
        </ActionIcon>
      </Table.Td>
      <Table.Td>
        <TextInput value={row.title} onChange={(e) => onFieldChange(chartId, 'title', e.currentTarget.value)} disabled={marked} required />
      </Table.Td>
      <Table.Td>
        <TextInput
          value={row.titleTranslit ?? ''}
          onChange={(e) => onFieldChange(chartId, 'titleTranslit', e.currentTarget.value || null)}
          disabled={marked}
        />
      </Table.Td>
      <Table.Td>
        <TextInput
          value={row.artist ?? ''}
          onChange={(e) => onFieldChange(chartId, 'artist', e.currentTarget.value || null)}
          disabled={marked}
        />
      </Table.Td>
      <Table.Td>
        <TextInput
          value={row.artistTranslit ?? ''}
          onChange={(e) => onFieldChange(chartId, 'artistTranslit', e.currentTarget.value || null)}
          disabled={marked}
        />
      </Table.Td>
      <Table.Td>
        <Select
          data={PLAYSTYLE_OPTIONS}
          value={row.playStyle}
          onChange={(v) => v && onFieldChange(chartId, 'playStyle', v as PlayStyle)}
          disabled={marked}
          allowDeselect={false}
          w={110}
        />
      </Table.Td>
      <Table.Td>
        <Select
          data={DIFFICULTY_OPTIONS}
          value={row.difficulty}
          onChange={(v) => v && onFieldChange(chartId, 'difficulty', v as DifficultySlot)}
          disabled={marked}
          allowDeselect={false}
          w={120}
        />
      </Table.Td>
      <Table.Td>
        <NumberInput
          value={row.meter}
          onChange={(v) => onFieldChange(chartId, 'meter', typeof v === 'number' ? v : 1)}
          disabled={marked}
          min={1}
          max={99}
          allowDecimal={false}
          w={80}
        />
      </Table.Td>
      <Table.Td>
        <Group justify="center">
          <Checkbox
            checked={row.flags.includes('noCmod')}
            onChange={(e) =>
              onFieldChange(chartId, 'flags', e.currentTarget.checked ? [...row.flags, 'noCmod'] : row.flags.filter((f) => f !== 'noCmod'))
            }
            disabled={marked}
            aria-label={`No CMOD for ${original.title}`}
          />
        </Group>
      </Table.Td>
      <Table.Td>
        <TextInput
          value={row.stepartist ?? ''}
          onChange={(e) => onFieldChange(chartId, 'stepartist', e.currentTarget.value || null)}
          disabled={marked}
        />
      </Table.Td>
      <Table.Td>
        <TextInput
          value={row.description ?? ''}
          onChange={(e) => onFieldChange(chartId, 'description', e.currentTarget.value || null)}
          disabled={marked}
        />
      </Table.Td>
    </Table.Tr>
  );
});

/**
 * The original single-view pack — filters, the editable table, and Import
 * — as its own tab now that the page has more than one. DESIGN.md, "The
 * pack tab": "the whole pack loads once and filters client-side... the
 * debounce is a render guard rather than a network one." Filters adapt to
 * the pack — playstyle only appears once the pack actually mixes Singles
 * and Doubles.
 *
 * Editing (DESIGN.md, "Song pack management": "inline edit... and
 * removal") needs no freeze rule — a chart already drawn renders from its
 * own snapshot, never re-read from this row — so Edit is offered
 * regardless of tournament state, unlike Import. The edited row set is
 * frozen from whatever the filters showed at the moment Edit was clicked,
 * so changing filters mid-edit can't silently drop or add rows out from
 * under an in-progress edit; the filters are disabled for the same reason.
 */
function AllSongsTab({
  tournamentId,
  charts,
  snapshot,
  isOrganizer,
}: {
  tournamentId: string;
  charts: ChartSnapshot[];
  snapshot: TournamentSnapshot | undefined;
  isOrganizer: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<PackFilters>(EMPTY_FILTERS);
  const [debounced] = useDebouncedValue(filters, 200);
  const [importOpen, { toggle: toggleImport }] = useDisclosure(false);

  const [editingRows, setEditingRows] = useState<ChartSnapshot[] | null>(null);
  const [edited, setEdited] = useState<Record<string, ChartInput>>({});
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());
  const [discardModalOpen, { open: openDiscardModal, close: closeDiscardModal }] = useDisclosure(false);

  const showPlayStyleFilter = useMemo(() => packHasMixedPlayStyles(charts), [charts]);
  const filtered = useMemo(() => filterCharts(charts, debounced), [charts, debounced]);

  const commitMutation = useMutation({
    mutationFn: () => {
      const rows = editingRows ?? [];
      const updates = rows
        .filter((c) => !pendingDelete.has(c.chartId) && isRowEdited(edited[c.chartId]!, c))
        .map((c) => ({ ...edited[c.chartId]!, chartId: c.chartId }));
      return commitPackChanges(tournamentId, updates, [...pendingDelete]);
    },
    onSuccess: () => {
      exitEditing();
      void queryClient.invalidateQueries({ queryKey: ['charts', tournamentId] });
    },
  });

  function exitEditing(): void {
    setEditingRows(null);
    setEdited({});
    setPendingDelete(new Set());
    commitMutation.reset();
  }

  function startEditing(): void {
    setEditingRows(filtered);
    setEdited(Object.fromEntries(filtered.map((c) => [c.chartId, { ...c }])));
    setPendingDelete(new Set());
  }

  function isDirty(c: ChartSnapshot): boolean {
    return pendingDelete.has(c.chartId) || isRowEdited(edited[c.chartId]!, c);
  }
  const anyDirty = (editingRows ?? []).some(isDirty);

  function handleCancelClick(): void {
    if (anyDirty) openDiscardModal();
    else exitEditing();
  }

  function confirmDiscard(): void {
    closeDiscardModal();
    exitEditing();
  }

  // Stable across every render — closes over the setter, not `edited`
  // itself — so `EditableChartRow`'s `React.memo` sees the same function
  // reference for every row, every time, and never re-renders on that
  // basis alone.
  const updateField = useCallback(<K extends (typeof EDITABLE_FIELDS)[number]>(chartId: string, field: K, value: ChartInput[K]): void => {
    setEdited((prev) => ({ ...prev, [chartId]: { ...prev[chartId]!, [field]: value } }));
  }, []);

  const toggleDelete = useCallback((chartId: string): void => {
    setPendingDelete((prev) => {
      const next = new Set(prev);
      if (next.has(chartId)) next.delete(chartId);
      else next.add(chartId);
      return next;
    });
  }, []);

  const isEditing = editingRows !== null;
  const rows = isEditing ? editingRows : filtered;

  return (
    <>
      {commitMutation.isError && (
        <Alert color="red" title="Couldn't save changes">
          {commitMutation.error instanceof Error ? commitMutation.error.message : 'Something went wrong.'}
        </Alert>
      )}

      <Modal opened={discardModalOpen} onClose={closeDiscardModal} title="Discard changes?">
        <Stack>
          <Text size="sm">You have unsaved edits. Discard them?</Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeDiscardModal}>
              Keep editing
            </Button>
            <Button color="red" onClick={confirmDiscard}>
              Discard
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/*
        Deliberate exception to this app's usual "no client-side tier
        check" convention (see e.g. `referee-overrides.tsx`) — pack
        editing controls are hidden for a non-organizer, not just
        server-rejected. `isOrganizer` is still only a UX nicety, not the
        real gate: the POST/PATCH endpoints enforce Tournament Organizer
        tier regardless. *When* import is legal at all is separate: once
        the tournament starts, the control is absent rather than
        present-but-erroring, same as every other frozen action in this
        app (DESIGN.md: "controls for frozen actions are not
        disabled-but-present; they are absent").
      */}
      {!isEditing && isOrganizer && snapshot && canImportPack(snapshot.state) && (
        <>
          <Group gap="xs" style={{ alignSelf: 'flex-start' }}>
            <Button variant="subtle" size="xs" onClick={toggleImport}>
              {importOpen ? 'Hide import' : 'Import pack'}
            </Button>
            <ImportPreviousEventButton tournamentId={tournamentId} />
          </Group>
          <Collapse in={importOpen}>
            <PackImport tournamentId={tournamentId} existingCharts={charts} />
          </Collapse>
        </>
      )}

      <div className={styles.filters}>
        <TextInput
          label="Search"
          placeholder="Title, artist, stepartist…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.currentTarget.value }))}
          disabled={isEditing}
          w={240}
        />
        <Select
          label="Difficulty"
          placeholder="Any"
          data={DIFFICULTY_OPTIONS}
          value={filters.difficulty}
          onChange={(v) => setFilters((f) => ({ ...f, difficulty: v as DifficultySlot | null }))}
          disabled={isEditing}
          clearable
          w={140}
        />
        <NumberInput
          label="Min rating"
          value={filters.minMeter ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, minMeter: typeof v === 'number' ? v : null }))}
          disabled={isEditing}
          w={110}
        />
        <NumberInput
          label="Max rating"
          value={filters.maxMeter ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, maxMeter: typeof v === 'number' ? v : null }))}
          disabled={isEditing}
          w={110}
        />
        {showPlayStyleFilter && (
          <Select
            label="Playstyle"
            placeholder="Any"
            data={PLAYSTYLE_OPTIONS}
            value={filters.playStyle}
            onChange={(v) => setFilters((f) => ({ ...f, playStyle: v as PlayStyle | null }))}
            disabled={isEditing}
            clearable
            w={130}
          />
        )}
        <Checkbox
          label="No CMOD only"
          checked={filters.noCmodOnly}
          onChange={(e) => setFilters((f) => ({ ...f, noCmodOnly: e.currentTarget.checked }))}
          disabled={isEditing}
          mb={8}
        />
      </div>

      {/* "A polite live region reporting '48 charts' after the debounce settles" — DESIGN.md, "The pack tab". */}
      <VisuallyHidden aria-live="polite" role="status">
        {filtered.length} chart{filtered.length === 1 ? '' : 's'}
      </VisuallyHidden>
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          {isEditing ? `${rows.length} chart${rows.length === 1 ? '' : 's'}` : `${filtered.length} of ${charts.length} charts`}
        </Text>
        {!isEditing ? (
          isOrganizer && (
            <Button variant="default" size="xs" onClick={startEditing}>
              Edit
            </Button>
          )
        ) : (
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={handleCancelClick}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => commitMutation.mutate()} loading={commitMutation.isPending} disabled={!anyDirty}>
              Save
            </Button>
          </Group>
        )}
      </Group>

      <Table>
        <Table.Thead>
          {isEditing ? (
            <Table.Tr>
              <Table.Th></Table.Th>
              <Table.Th>Title</Table.Th>
              <Table.Th>Title (Translit)</Table.Th>
              <Table.Th>Artist</Table.Th>
              <Table.Th>Artist (Translit)</Table.Th>
              <Table.Th>Playstyle</Table.Th>
              <Table.Th>Difficulty</Table.Th>
              <Table.Th>Meter</Table.Th>
              <Table.Th style={{ textAlign: 'center' }}>No CMOD</Table.Th>
              <Table.Th>Stepartist</Table.Th>
              <Table.Th>Description</Table.Th>
            </Table.Tr>
          ) : (
            <Table.Tr>
              <Table.Th>Chart</Table.Th>
              <Table.Th>Level</Table.Th>
              <Table.Th>Stepartist/Description</Table.Th>
            </Table.Tr>
          )}
        </Table.Thead>
        <Table.Tbody>
          {!isEditing
            ? rows.map((c) => (
                <Table.Tr key={c.chartId}>
                  <Table.Td>
                    {displayTitle(c)}
                    {displaySubtitle(c) ? ` ${displaySubtitle(c)}` : ''}
                    {/*
                      Not appended as text: a pack's own subtitle commonly
                      already spells out "(No CMOD)" verbatim — that's how the
                      flag gets inferred at import in the first place (see
                      DESIGN.md, "Client-Side Song Pack Parsing") — so
                      concatenating it again here would print it twice for
                      most flagged charts.
                    */}
                    {c.flags.includes('noCmod') && (
                      <Badge ml={6} size="xs" variant="light" color="red">
                        🚫 No CMOD
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {playstylePrefix(c.playStyle, c.difficulty)}
                    {c.meter}
                  </Table.Td>
                  <Table.Td>{displayStepartistLine(c)}</Table.Td>
                </Table.Tr>
              ))
            : rows.map((c) => (
                <EditableChartRow
                  key={c.chartId}
                  original={c}
                  row={edited[c.chartId]!}
                  marked={pendingDelete.has(c.chartId)}
                  onFieldChange={updateField}
                  onToggleDelete={toggleDelete}
                />
              ))}
        </Table.Tbody>
      </Table>
    </>
  );
}

/** Every missing-label line grouped by category, then every duplicate-label line — the shorthand-vs-group-name rule: a category's full name only when it's the group being talked about, the specific songs always by their shorthand label. */
function summarizeIssues(issues: SongPoolIssues, chartTitle: (chartId: string) => string): string[] {
  const lines: string[] = [];
  const missingByCategory = new Map<PoolCategory, string[]>();
  for (const label of issues.missingLabels) {
    const category = poolCategoryOf(label);
    missingByCategory.set(category, [...(missingByCategory.get(category) ?? []), label]);
  }
  for (const [category, labels] of missingByCategory) {
    lines.push(`${POOL_CATEGORY_LABEL[category]} is missing ${labels.join(', ')}.`);
  }
  for (const [label, chartIds] of Object.entries(issues.duplicateLabels)) {
    lines.push(`${label} is assigned to more than one song: ${chartIds.map(chartTitle).join(', ')}.`);
  }
  return lines;
}

/**
 * A static-pool format's labeling tab (NEW_FORMAT.md's "Song Pool") — the
 * same chart table as "All Songs", plus a per-row label `Select` scoped to
 * this format's required labels. Single-select per row makes "one song,
 * one label" structural, satisfying the spec's "the UI should restrict
 * this entirely" for that case; a label reused across songs is allowed
 * here and only reported by Save, per the spec's own wording.
 *
 * No Edit-mode toggle, unlike "All Songs": labeling never touches a
 * `Chart` row, so there's no freeze concern to buffer against — every
 * row's `Select` is always live for an organizer (while the tournament
 * hasn't started — see `canEditSongPool`), and "Save" persists whatever's
 * currently selected. Never blocked by an incomplete or conflicting pool
 * — only Start Tournament is; Save always commits and shows what's still
 * wrong.
 *
 * `isOrganizer` hides the `Select`/Save entirely for anyone else, in
 * place of the plain assigned label — a deliberate exception to this
 * app's usual "controls stay present, the server's rejection is the only
 * gate" convention (see `AllSongsTab`'s Import button comment).
 * `canEditSongPool(state)` hides them the same way once the tournament
 * has started — the server rejects a Save from then on regardless.
 */
function StaticPoolTab({
  tournamentId,
  formatKey,
  charts,
  isOrganizer,
  state,
}: {
  tournamentId: string;
  formatKey: FormatKey;
  charts: ChartSnapshot[];
  isOrganizer: boolean;
  state: TournamentState | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const requiredLabels = FORMAT_SONG_LABELS[formatKey] ?? [];
  const labelOptions = requiredLabels.map((label) => ({ value: label, label }));

  const { data, isPending, isError } = useQuery({
    queryKey: ['song-pools', tournamentId],
    queryFn: () => fetchSongPools(tournamentId),
  });
  const tab = data?.tabs.find((t) => t.formatKey === formatKey);

  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [lastSavedIssues, setLastSavedIssues] = useState<SongPoolIssues | null | undefined>(undefined);
  const seeded = useRef(false);

  // Seeds local state from the fetched tab exactly once it arrives — after
  // that, this component owns the value until Save round-trips a fresh copy.
  useEffect(() => {
    if (tab && !seeded.current) {
      setAssignments(tab.assignments);
      seeded.current = true;
    }
  }, [tab]);

  const saveMutation = useMutation({
    mutationFn: () => saveSongPoolLabels(tournamentId, formatKey, assignments),
    onSuccess: (result) => {
      setLastSavedIssues(result.issues);
      void queryClient.invalidateQueries({ queryKey: ['song-pools', tournamentId] });
    },
  });

  const dirty = tab ? JSON.stringify(assignments) !== JSON.stringify(tab.assignments) : false;
  const chartTitle = (chartId: string) => charts.find((c) => c.chartId === chartId)?.title ?? chartId;
  const canEdit = isOrganizer && state !== undefined && canEditSongPool(state);

  if (isPending) {
    return (
      <Center h="40vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  }
  if (isError || !tab) {
    return (
      <Alert color="red" title="Couldn't load this pool">
        Try again in a moment.
      </Alert>
    );
  }

  return (
    <>
      {saveMutation.isError && (
        <Alert color="red" title="Couldn't save this pool">
          {saveMutation.error instanceof ApiError ? saveMutation.error.message : 'Something went wrong.'}
        </Alert>
      )}
      {lastSavedIssues && (
        <Alert color="yellow" title="Saved, but this pool isn't well-formed yet">
          <Stack gap={4}>
            {summarizeIssues(lastSavedIssues, chartTitle).map((line) => (
              <Text key={line} size="sm">
                {line}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          {Object.keys(assignments).length} of {requiredLabels.length} labels assigned
        </Text>
        {canEdit && (
          <Button size="xs" onClick={() => saveMutation.mutate()} loading={saveMutation.isPending} disabled={!dirty}>
            Save
          </Button>
        )}
      </Group>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Chart</Table.Th>
            <Table.Th>Level</Table.Th>
            <Table.Th style={{ width: 140 }}>Label</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {charts.map((c) => (
            <Table.Tr key={c.chartId}>
              <Table.Td>
                {displayTitle(c)}
                {displaySubtitle(c) ? ` ${displaySubtitle(c)}` : ''}
              </Table.Td>
              <Table.Td>
                {playstylePrefix(c.playStyle, c.difficulty)}
                {c.meter}
              </Table.Td>
              <Table.Td>
                {canEdit ? (
                  <Select
                    placeholder="—"
                    data={labelOptions}
                    value={assignments[c.chartId] ?? null}
                    onChange={(value) =>
                      setAssignments((prev) => {
                        const next = { ...prev };
                        if (value) next[c.chartId] = value;
                        else delete next[c.chartId];
                        return next;
                      })
                    }
                    clearable
                    w={120}
                  />
                ) : (
                  (assignments[c.chartId] ?? '—')
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}

/** The "+" tab — opens a modal to pick which static-pool format to create a tab for, filtered to ones this tournament doesn't already have. */
function CreatePoolTabButton({
  tournamentId,
  existingFormats,
  isOrganizer,
}: {
  tournamentId: string;
  existingFormats: FormatKey[];
  isOrganizer: boolean;
}): JSX.Element | null {
  const [opened, { open, close }] = useDisclosure(false);
  const [formatKey, setFormatKey] = useState<FormatKey | null>(null);
  const queryClient = useQueryClient();

  const staticFormats = (Object.keys(FORMAT_STATIC_SONG_POOL) as FormatKey[]).filter(
    (key) => FORMAT_STATIC_SONG_POOL[key] && !existingFormats.includes(key),
  );

  const mutation = useMutation({
    mutationFn: () => createSongPoolTab(tournamentId, formatKey!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['song-pools', tournamentId] });
      handleClose();
    },
  });

  function handleClose(): void {
    close();
    setFormatKey(null);
    mutation.reset();
  }

  // Not an organizer, or nothing left to add — every static-pool format
  // already has a tab.
  if (!isOrganizer || staticFormats.length === 0) return null;

  return (
    <>
      <ActionIcon variant="subtle" onClick={open} aria-label="Add a song pool tab" ml={4}>
        +
      </ActionIcon>
      <Modal opened={opened} onClose={handleClose} title="Add a song pool">
        <Stack>
          {mutation.isError && (
            <Alert color="red" title="Couldn't add that pool">
              {mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.'}
            </Alert>
          )}
          <Select
            label="Format"
            placeholder="Choose a format"
            data={staticFormats.map((key) => ({ value: key, label: FORMAT_SHORT_LABEL[key] }))}
            value={formatKey}
            onChange={(v) => setFormatKey(v as FormatKey | null)}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!formatKey}>
              Add
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * A tab's own "×" — confirms before deleting, same discard-confirm shape
 * `AllSongsTab` uses. Absent entirely for anyone but an organizer, and
 * once the tournament has started (`canEditSongPool`) — the server
 * rejects the delete from then on regardless.
 */
function DeletePoolTabButton({
  tournamentId,
  formatKey,
  isOrganizer,
  state,
}: {
  tournamentId: string;
  formatKey: FormatKey;
  isOrganizer: boolean;
  state: TournamentState | undefined;
}): JSX.Element | null {
  const [opened, { open, close }] = useDisclosure(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteSongPoolTab(tournamentId, formatKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['song-pools', tournamentId] });
      close();
    },
  });

  if (!isOrganizer || state === undefined || !canEditSongPool(state)) return null;

  return (
    <>
      <ActionIcon
        component="span"
        variant="subtle"
        size="xs"
        color="gray"
        aria-label={`Remove the ${FORMAT_SHORT_LABEL[formatKey]} song pool`}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
      >
        <CloseIcon />
      </ActionIcon>
      <Modal opened={opened} onClose={close} title={`Remove the ${FORMAT_SHORT_LABEL[formatKey]} song pool?`}>
        <Stack>
          <Text size="sm">This deletes every label assigned in this tab. It can be recreated, but the labels can't.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={close}>
              Keep it
            </Button>
            <Button color="red" onClick={() => mutation.mutate()} loading={mutation.isPending}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

export default function TournamentPack(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const {
    data: charts,
    isPending,
    isError,
  } = useQuery({
    queryKey: ['charts', tournamentId],
    queryFn: () => fetchCharts(tournamentId!),
  });
  const { data: snapshot } = useTournament(tournamentId!);
  const { data: songPools } = useQuery({
    queryKey: ['song-pools', tournamentId],
    queryFn: () => fetchSongPools(tournamentId!),
  });
  // Pack editing (Edit, Import, and every song-pool control) is
  // Tournament-Organizer-only — a deliberate exception to this app's usual
  // "controls stay present, the server's rejection is the only real gate"
  // convention. `lifecycleStatus` is organizer-only data (403s otherwise),
  // so whether the fetch succeeded doubles as the client's best-effort
  // organizer signal — same inferred pattern `tournament-bracket.tsx` and
  // `match-detail.tsx` already use. It's still only a UX nicety: the
  // POST/PATCH/DELETE endpoints enforce the real tier check regardless.
  const { data: lifecycleStatus } = useLifecycleStatus(tournamentId!);
  const isOrganizer = lifecycleStatus !== undefined;
  const poolTabs = songPools?.tabs ?? [];
  const [activeTab, setActiveTab] = useState<string>('all');

  // Deleting the tab you're currently viewing (or, just as well, its
  // format's static pool going away from under you some other way) drops
  // you back to "All Songs" instead of leaving the view stranded on a tab
  // that no longer has a panel to render.
  useEffect(() => {
    if (activeTab !== 'all' && !poolTabs.some((t) => t.formatKey === activeTab)) {
      setActiveTab('all');
    }
  }, [activeTab, poolTabs]);

  let content: JSX.Element;

  if (isPending) {
    content = (
      <Center h="60vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  } else if (isError) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load the pack">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    content = (
      <Tabs value={activeTab} onChange={(v) => v && setActiveTab(v)}>
        <Tabs.List>
          <Tabs.Tab value="all">All Songs</Tabs.Tab>
          {poolTabs.map((t) => (
            <Tabs.Tab
              key={t.formatKey}
              value={t.formatKey}
              rightSection={
                <DeletePoolTabButton tournamentId={tournamentId!} formatKey={t.formatKey} isOrganizer={isOrganizer} state={snapshot?.state} />
              }
            >
              {FORMAT_SHORT_LABEL[t.formatKey]}
            </Tabs.Tab>
          ))}
          <CreatePoolTabButton tournamentId={tournamentId!} existingFormats={poolTabs.map((t) => t.formatKey)} isOrganizer={isOrganizer} />
        </Tabs.List>

        <Tabs.Panel value="all" pt="md">
          <Stack gap="lg">
            <AllSongsTab tournamentId={tournamentId!} charts={charts} snapshot={snapshot} isOrganizer={isOrganizer} />
          </Stack>
        </Tabs.Panel>
        {poolTabs.map((t) => (
          <Tabs.Panel key={t.formatKey} value={t.formatKey} pt="md">
            <Stack gap="lg">
              <StaticPoolTab
                tournamentId={tournamentId!}
                formatKey={t.formatKey}
                charts={charts}
                isOrganizer={isOrganizer}
                state={snapshot?.state}
              />
            </Stack>
          </Tabs.Panel>
        ))}
      </Tabs>
    );
  }

  return (
    <Stack gap="lg" p="md">
      <TournamentHeader tournamentId={tournamentId!} />
      <Title order={2}>Song Pack</Title>
      {content}
    </Stack>
  );
}
