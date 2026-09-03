import { FORMAT_SHORT_LABEL, type FormatKey } from '@itg/shared';
import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, fetchCharts, fetchImportCandidates, fetchSongPools, importFromPreviousTournament } from '../lib/api.js';

/**
 * "Previous event" — the pack view's alternative to a zip upload: copy a
 * finished tournament's whole pack into this one. Two steps in one modal:
 * pick a past tournament from this server, then pick which of its
 * song-pool tabs to bring the label assignments for (every song comes
 * over either way — see `importFromPreviousTournament`'s own comment for
 * why the checkboxes only gate labels, not charts).
 */
export function ImportPreviousEventButton({ tournamentId }: { tournamentId: string }): JSX.Element {
  const [opened, { open, close }] = useDisclosure(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [checkedFormats, setCheckedFormats] = useState<Set<FormatKey>>(new Set());
  const queryClient = useQueryClient();

  const candidatesQuery = useQuery({
    queryKey: ['import-candidates', tournamentId],
    queryFn: () => fetchImportCandidates(tournamentId),
    enabled: opened,
  });

  const sourceChartsQuery = useQuery({
    queryKey: ['charts', sourceId],
    queryFn: () => fetchCharts(sourceId!),
    enabled: sourceId !== null,
  });
  const sourcePoolsQuery = useQuery({
    queryKey: ['song-pools', sourceId],
    queryFn: () => fetchSongPools(sourceId!),
    enabled: sourceId !== null,
  });

  // Every pool tab starts checked, the instant the source's own tabs load.
  useEffect(() => {
    if (sourcePoolsQuery.data) setCheckedFormats(new Set(sourcePoolsQuery.data.tabs.map((t) => t.formatKey)));
  }, [sourcePoolsQuery.data]);

  const importMutation = useMutation({
    mutationFn: () => importFromPreviousTournament(tournamentId, sourceId!, [...checkedFormats]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['charts', tournamentId] });
      void queryClient.invalidateQueries({ queryKey: ['song-pools', tournamentId] });
      handleClose();
    },
  });

  function handleClose(): void {
    close();
    setSourceId(null);
    setCheckedFormats(new Set());
    importMutation.reset();
  }

  function pickTournament(id: string, chartCount: number): void {
    if (chartCount === 0) return; // the button is disabled for this case too — belt and suspenders
    importMutation.reset();
    setSourceId(id);
  }

  function back(): void {
    importMutation.reset();
    setSourceId(null);
    setCheckedFormats(new Set());
  }

  function toggleFormat(key: FormatKey): void {
    setCheckedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const candidates = candidatesQuery.data?.tournaments ?? [];
  const sourceTabs = sourcePoolsQuery.data?.tabs ?? [];
  const songCount = sourceChartsQuery.data?.length ?? 0;
  const poolCount = checkedFormats.size;
  const loadingSource = sourceChartsQuery.isPending || sourcePoolsQuery.isPending;

  return (
    <>
      <Button variant="subtle" size="xs" onClick={open}>
        Previous event
      </Button>
      <Modal opened={opened} onClose={handleClose} title="Import from a previous event">
        <Stack>
          {sourceId === null ? (
            <>
              {candidatesQuery.isPending && <Loader size="sm" />}
              {candidatesQuery.isError && (
                <Alert color="red" title="Couldn't load past tournaments">
                  Try again in a moment.
                </Alert>
              )}
              {candidatesQuery.data && candidates.length === 0 && (
                <Text size="sm" c="dimmed">
                  This server has no finished tournaments to import from yet.
                </Text>
              )}
              {candidates.length > 0 && (
                <Stack gap={4}>
                  {candidates.map((t) => {
                    const empty = t.chartCount === 0;
                    const label = `${t.name} (${new Date(t.createdAt).toLocaleDateString()})`;
                    const row = (
                      <Button key={t.id} variant="default" fullWidth disabled={empty} onClick={() => pickTournament(t.id, t.chartCount)}>
                        {label}
                      </Button>
                    );
                    // A disabled native button fires no hover events, so
                    // `Tooltip` needs a wrapper element to hang its own
                    // listeners on instead.
                    return empty ? (
                      <Tooltip key={t.id} label="No songs to import">
                        <span>{row}</span>
                      </Tooltip>
                    ) : (
                      row
                    );
                  })}
                </Stack>
              )}
              <Group justify="flex-end">
                <Button variant="subtle" onClick={handleClose}>
                  Cancel
                </Button>
              </Group>
            </>
          ) : (
            <>
              {importMutation.isError && (
                <Alert color="red" title="Couldn't import">
                  {importMutation.error instanceof ApiError ? importMutation.error.message : 'Something went wrong.'}
                </Alert>
              )}
              {loadingSource && <Loader size="sm" />}
              {!loadingSource && sourceTabs.length === 0 && (
                <Text size="sm" c="dimmed">
                  That tournament had no song pool tabs — its {songCount} song{songCount === 1 ? '' : 's'} will still come over.
                </Text>
              )}
              {!loadingSource && sourceTabs.length > 0 && (
                <Stack gap={4}>
                  {sourceTabs.map((t) => (
                    <Checkbox
                      key={t.formatKey}
                      label={`${FORMAT_SHORT_LABEL[t.formatKey]} (${Object.keys(t.assignments).length} songs labeled)`}
                      checked={checkedFormats.has(t.formatKey)}
                      onChange={() => toggleFormat(t.formatKey)}
                    />
                  ))}
                </Stack>
              )}
              {!loadingSource && (
                <Text fw={600}>
                  Import {songCount} song{songCount === 1 ? '' : 's'} and {poolCount} song pool{poolCount === 1 ? '' : 's'}?
                </Text>
              )}
              <Group justify="space-between">
                <Button variant="subtle" onClick={back} disabled={importMutation.isPending}>
                  Back
                </Button>
                <Group>
                  <Button variant="subtle" onClick={handleClose} disabled={importMutation.isPending}>
                    Cancel
                  </Button>
                  <Button onClick={() => importMutation.mutate()} loading={importMutation.isPending} disabled={loadingSource}>
                    Confirm
                  </Button>
                </Group>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
