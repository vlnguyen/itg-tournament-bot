import type { ChartInput, ChartSnapshot } from '@itg/shared';
import { Alert, Badge, Button, Checkbox, FileInput, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { importCharts } from '../lib/api.js';
import { buildPreview } from '../lib/pack-import/dedupe.js';
import { parseDirectory } from '../lib/pack-import/parse-directory.js';
import { parseZipFile } from '../lib/pack-import/parse-zip-file.js';

/** Chromium/Firefox only as of writing — Safari has no File System Access API. The `.zip` input is always available as DESIGN.md's own documented fallback. */
const supportsDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const PLAYSTYLE_LABEL: Record<ChartInput['playStyle'], string> = { SINGLE: 'Single', DOUBLE: 'Double' };
const DIFFICULTY_LABEL: Record<ChartInput['difficulty'], string> = {
  NOVICE: 'Novice',
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
  EXPERT: 'Expert',
};

/**
 * The organizer import flow — DESIGN.md, "Client-Side Song Pack Parsing":
 * "Browser reads a `.zip` or directory (File System Access API, with a
 * `.zip` fallback)." Either path ends up parsing in a Web Worker and
 * landing in the same `parsed` state, so the preview/select/import
 * pipeline below neither knows nor cares which one produced it.
 *
 * The preview table shows exactly the fields `ChartInput` commits to the
 * database, raw — not the resolved "whichever form is set" a public chart
 * display uses (`displayTitle`/`displayArtist`) — so an organizer can spot
 * a transliteration that parsed wrong before it lands in the pack.
 *
 * Only on confirmation does anything reach the server, and only the
 * checked rows — which re-validates the whole payload regardless of what
 * this UI already checked. Authorization is enforced server-side
 * (Tournament Organizer tier for this guild); a non-organizer sees the
 * resulting error rather than a client-side gate that would just be
 * theater.
 */
export function PackImport({ tournamentId, existingCharts }: { tournamentId: string; existingCharts: ChartSnapshot[] }): JSX.Element {
  const [parsed, setParsed] = useState<ChartInput[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: () => importCharts(tournamentId, (parsed ?? []).filter((_, i) => selected.has(i))),
    onSuccess: () => {
      setParsed(null);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['charts', tournamentId] });
    },
  });

  const runParse = (promise: Promise<ChartInput[]>): void => {
    setParseError(null);
    setParsed(null);
    setSelected(new Set());
    importMutation.reset();
    setIsParsing(true);
    promise
      .then((charts) => {
        if (charts.length === 0) {
          setParseError('No charts found in that file.');
          return;
        }
        // Duplicates start unchecked — flagging them is only useful if it
        // actually keeps them from being blindly re-imported.
        const rows = buildPreview(charts, existingCharts);
        setSelected(new Set(rows.flatMap((row, i) => (row.isDuplicate ? [] : [i]))));
        setParsed(charts);
      })
      .catch((err: unknown) => setParseError(err instanceof Error ? err.message : String(err)))
      .finally(() => setIsParsing(false));
  };

  const handleFile = (file: File | null): void => {
    if (!file) return;
    runParse(parseZipFile(file));
  };

  const handleChooseFolder = (): void => {
    window
      .showDirectoryPicker!()
      .then((handle) => runParse(parseDirectory(handle)))
      .catch((err: unknown) => {
        // The user closing the picker rejects with AbortError — not a real failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setParseError(err instanceof Error ? err.message : String(err));
      });
  };

  const preview = parsed ? buildPreview(parsed, existingCharts) : null;

  const selectAll = (): void => setSelected(new Set(preview?.map((_, i) => i)));
  const selectNone = (): void => setSelected(new Set());
  const selectExpertSingles = (): void =>
    setSelected(
      new Set((preview ?? []).flatMap((row, i) => (row.chart.playStyle === 'SINGLE' && row.chart.difficulty === 'EXPERT' ? [i] : []))),
    );

  const toggleRow = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const toggleNoCmod = (i: number, checked: boolean): void => {
    setParsed((prev) =>
      (prev ?? []).map((chart, idx) =>
        idx === i ? { ...chart, flags: checked ? [...chart.flags, 'noCmod'] : chart.flags.filter((f) => f !== 'noCmod') } : chart,
      ),
    );
  };

  return (
    <Stack gap="sm">
      <Group align="flex-end">
        <FileInput
          label={supportsDirectoryPicker ? 'Import a pack (.zip)' : 'Import a pack (.zip or a folder)'}
          placeholder="Choose a file"
          accept=".zip"
          onChange={handleFile}
          disabled={isParsing}
          style={{ flex: 1 }}
        />
        {supportsDirectoryPicker && (
          <Button variant="default" onClick={handleChooseFolder} disabled={isParsing}>
            Choose a folder instead
          </Button>
        )}
      </Group>

      {isParsing && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Parsing pack…
          </Text>
        </Group>
      )}

      {parseError && (
        <Alert color="red" title="Couldn't parse that file">
          {parseError}
        </Alert>
      )}

      {importMutation.isError && (
        <Alert color="red" title="Import failed">
          {importMutation.error instanceof Error ? importMutation.error.message : 'Something went wrong.'}
        </Alert>
      )}

      {importMutation.isSuccess && (
        <Alert color="green" title="Imported">
          {importMutation.data.imported} chart{importMutation.data.imported === 1 ? '' : 's'} added to the pack.
        </Alert>
      )}

      {preview && preview.length > 0 && (
        <>
          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm">
              Found {preview.length} chart{preview.length === 1 ? '' : 's'} — {preview.filter((r) => r.isDuplicate).length} already in the
              pack — {selected.size} selected.
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={selectAll}>
                Select All
              </Button>
              <Button size="xs" variant="default" onClick={selectNone}>
                Unselect All
              </Button>
              <Button size="xs" variant="default" onClick={selectExpertSingles}>
                Expert only (Singles)
              </Button>
            </Group>
          </Group>
          <Table>
            <Table.Thead>
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
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.map((row, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <Checkbox checked={selected.has(i)} onChange={() => toggleRow(i)} aria-label={`Include ${row.chart.title}`} />
                  </Table.Td>
                  <Table.Td>{row.chart.title}</Table.Td>
                  <Table.Td>{row.chart.titleTranslit ?? '—'}</Table.Td>
                  <Table.Td>{row.chart.artist ?? '—'}</Table.Td>
                  <Table.Td>{row.chart.artistTranslit ?? '—'}</Table.Td>
                  <Table.Td>{PLAYSTYLE_LABEL[row.chart.playStyle]}</Table.Td>
                  <Table.Td>{DIFFICULTY_LABEL[row.chart.difficulty]}</Table.Td>
                  <Table.Td>{row.chart.meter}</Table.Td>
                  <Table.Td>
                    <Group justify="center">
                      <Checkbox
                        checked={row.chart.flags.includes('noCmod')}
                        onChange={(e) => toggleNoCmod(i, e.currentTarget.checked)}
                        aria-label={`No CMOD for ${row.chart.title}`}
                      />
                    </Group>
                  </Table.Td>
                  <Table.Td>{row.chart.stepartist ?? '—'}</Table.Td>
                  <Table.Td>{row.chart.description ?? '—'}</Table.Td>
                  <Table.Td>{row.isDuplicate && <Badge color="yellow">Already in pack</Badge>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group>
            <Button onClick={() => importMutation.mutate()} loading={importMutation.isPending} disabled={selected.size === 0}>
              Confirm import ({selected.size})
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
