import { displayArtist, displaySubtitle, displayTitle, playstylePrefix } from '@itg/shared';
import type { DifficultySlot, PlayStyle } from '@itg/shared';
import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Collapse,
  Loader,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PackImport } from '../components/pack-import.js';
import { fetchCharts } from '../lib/api.js';
import { EMPTY_FILTERS, filterCharts, packHasMixedPlayStyles, type PackFilters } from '../lib/pack-search.js';
import styles from './tournament-pack.module.css';

const DIFFICULTY_OPTIONS: { value: DifficultySlot; label: string }[] = [
  { value: 'NOVICE', label: 'Novice' },
  { value: 'EASY', label: 'Easy' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HARD', label: 'Hard' },
  { value: 'EXPERT', label: 'Expert' },
];

/**
 * `/t/:tournamentId/pack` — DESIGN.md, "The pack tab": "the whole pack
 * loads once and filters client-side... the debounce is a render guard
 * rather than a network one." Filters adapt to the pack — playstyle only
 * appears once the pack actually mixes Singles and Doubles.
 */
export default function TournamentPack(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: charts, isPending, isError } = useQuery({
    queryKey: ['charts', tournamentId],
    queryFn: () => fetchCharts(tournamentId!),
  });

  const [filters, setFilters] = useState<PackFilters>(EMPTY_FILTERS);
  const [debounced] = useDebouncedValue(filters, 200);
  const [importOpen, { toggle: toggleImport }] = useDisclosure(false);

  const showPlayStyleFilter = useMemo(() => (charts ? packHasMixedPlayStyles(charts) : false), [charts]);
  const filtered = useMemo(() => (charts ? filterCharts(charts, debounced) : []), [charts, debounced]);

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
        <Alert color="red" title="Couldn't load the pack">
          Try again in a moment.
        </Alert>
      </Center>
    );
  }

  return (
    <Stack gap="lg" p="md">
      <Title order={1}>Song Pack</Title>

      {/*
        No client-side permission check — the server is the only real
        gate (Tournament Organizer tier, checked on POST). Showing this
        to everyone costs nothing; a non-organizer who tries it just sees
        the resulting error, same as any other server-enforced action in
        this app.
      */}
      <Button variant="subtle" size="xs" onClick={toggleImport} style={{ alignSelf: 'flex-start' }}>
        {importOpen ? 'Hide import' : 'Import pack'}
      </Button>
      <Collapse in={importOpen}>
        <PackImport tournamentId={tournamentId!} existingCharts={charts} />
      </Collapse>

      <div className={styles.filters}>
        <TextInput
          label="Search"
          placeholder="Title, artist, stepartist…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.currentTarget.value }))}
          w={240}
        />
        <Select
          label="Difficulty"
          placeholder="Any"
          data={DIFFICULTY_OPTIONS}
          value={filters.difficulty}
          onChange={(v) => setFilters((f) => ({ ...f, difficulty: v as DifficultySlot | null }))}
          clearable
          w={140}
        />
        <NumberInput
          label="Min rating"
          value={filters.minMeter ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, minMeter: typeof v === 'number' ? v : null }))}
          w={110}
        />
        <NumberInput
          label="Max rating"
          value={filters.maxMeter ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, maxMeter: typeof v === 'number' ? v : null }))}
          w={110}
        />
        {showPlayStyleFilter && (
          <Select
            label="Playstyle"
            placeholder="Any"
            data={[
              { value: 'SINGLE', label: 'Single' },
              { value: 'DOUBLE', label: 'Double' },
            ]}
            value={filters.playStyle}
            onChange={(v) => setFilters((f) => ({ ...f, playStyle: v as PlayStyle | null }))}
            clearable
            w={130}
          />
        )}
        <Checkbox
          label="No CMOD only"
          checked={filters.noCmodOnly}
          onChange={(e) => setFilters((f) => ({ ...f, noCmodOnly: e.currentTarget.checked }))}
          mb={8}
        />
      </div>

      {/* "A polite live region reporting '48 charts' after the debounce settles" — DESIGN.md, "The pack tab". */}
      <VisuallyHidden aria-live="polite" role="status">
        {filtered.length} chart{filtered.length === 1 ? '' : 's'}
      </VisuallyHidden>
      <Text size="sm" c="dimmed">
        {filtered.length} of {charts.length} charts
      </Text>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Chart</Table.Th>
            <Table.Th>Artist</Table.Th>
            <Table.Th>Level</Table.Th>
            <Table.Th>Stepartist</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {filtered.map((c) => (
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
                  <Badge ml={6} size="xs" variant="light">
                    No CMOD
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>{displayArtist(c) ?? '—'}</Table.Td>
              <Table.Td>
                {playstylePrefix(c.playStyle, c.difficulty)}
                {c.meter}
              </Table.Td>
              <Table.Td>{c.stepartist ?? '—'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
