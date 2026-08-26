import type { ChartInput, ChartSnapshot } from '@itg/shared';
import { displayArtist, displayTitle, playstylePrefix } from '@itg/shared';
import { Alert, Badge, Button, FileInput, Group, Stack, Table, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { importCharts } from '../lib/api.js';
import { buildPreview } from '../lib/pack-import/dedupe.js';
import { parseZipFile } from '../lib/pack-import/parse-zip-file.js';

/**
 * The organizer import flow — DESIGN.md, "Client-Side Song Pack Parsing":
 * browser reads the zip, parses in a Web Worker, shows a preview with
 * duplicates flagged, and only on confirmation does anything reach the
 * server — which re-validates the whole payload regardless of what this
 * UI already checked. Authorization is enforced server-side (Tournament
 * Organizer tier for this guild); a non-organizer sees the resulting
 * error rather than a client-side gate that would just be theater.
 */
export function PackImport({ tournamentId, existingCharts }: { tournamentId: string; existingCharts: ChartSnapshot[] }): JSX.Element {
  const [parsed, setParsed] = useState<ChartInput[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: () => importCharts(tournamentId, parsed ?? []),
    onSuccess: () => {
      setParsed(null);
      void queryClient.invalidateQueries({ queryKey: ['charts', tournamentId] });
    },
  });

  const handleFile = (file: File | null): void => {
    setParseError(null);
    setParsed(null);
    importMutation.reset();
    if (!file) return;

    setIsParsing(true);
    parseZipFile(file)
      .then((charts) => {
        if (charts.length === 0) setParseError('No charts found in that file.');
        setParsed(charts);
      })
      .catch((err: unknown) => setParseError(err instanceof Error ? err.message : String(err)))
      .finally(() => setIsParsing(false));
  };

  const preview = parsed ? buildPreview(parsed, existingCharts) : null;

  return (
    <Stack gap="sm">
      <FileInput label="Import a pack (.zip)" placeholder="Choose a file" accept=".zip" onChange={handleFile} disabled={isParsing} />

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
          <Text size="sm">
            Found {preview.length} chart{preview.length === 1 ? '' : 's'} — {preview.filter((r) => r.isDuplicate).length} already in the pack.
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Chart</Table.Th>
                <Table.Th>Artist</Table.Th>
                <Table.Th>Level</Table.Th>
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.map((row, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{displayTitle(row.chart)}</Table.Td>
                  <Table.Td>{displayArtist(row.chart) ?? '—'}</Table.Td>
                  <Table.Td>
                    {playstylePrefix(row.chart.playStyle, row.chart.difficulty)}
                    {row.chart.meter}
                  </Table.Td>
                  <Table.Td>{row.isDuplicate && <Badge color="yellow">Already in pack</Badge>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group>
            <Button onClick={() => importMutation.mutate()} loading={importMutation.isPending}>
              Confirm import
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
