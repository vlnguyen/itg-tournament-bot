import type { PoolChartRow, PoolTally } from '@itg/shared';
import { FORMAT_LABEL, type FormatKey } from '@itg/shared';
import { Alert, Center, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { ApiError, fetchTournamentAnalytics } from '../lib/api.js';

function poolLabel(formatKey: string): string {
  return FORMAT_LABEL[formatKey as FormatKey] ?? formatKey;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Same "Xh Ym" shape as `lib/format-duration.ts`'s `elapsedLabel`, but over an already-computed minute count rather than an ISO timestamp — `elapsedMinutes`/`averageRoundMinutes` are fixed at fetch time (`endedAt` if the tournament finished), not "how long ago from now". */
function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function ChartTallyTable({
  title,
  countLabel,
  rows,
}: {
  title: string;
  countLabel: string;
  rows: { chartId: string; title: string; count: number }[];
}): JSX.Element {
  return (
    <div>
      <Title order={3} size="h5" mb="xs">
        {title}
      </Title>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          None yet.
        </Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Chart</Table.Th>
              <Table.Th>{countLabel}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.chartId}>
                <Table.Td>{r.title}</Table.Td>
                <Table.Td>{r.count}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}

type SortKey = 'title' | 'vetoes' | 'picks';

/** Each column's first click direction — counts start high-to-low (most interesting first), title starts A-to-Z. */
const DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = { title: 'asc', vetoes: 'desc', picks: 'desc' };

/**
 * One sortable table per song pool actually in play — every chart labeled
 * into that pool, counts included even at zero. Never a top N: a TO
 * reviewing pick/veto patterns needs the songs nobody touched as much as
 * the popular ones. Starts in the pool's own draw order (the server's
 * default). Clicking a header cycles three states rather than just
 * toggling: first click sorts one way, a second click on the same header
 * reverses it, a third returns to the original, unsorted default order —
 * there's otherwise no way back to "the order it actually gets drawn in"
 * once you've sorted by count.
 */
function SongPoolTable({ pool }: { pool: PoolTally }): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return pool.charts;
    const { key, dir } = sort;
    const sign = dir === 'asc' ? 1 : -1;
    return [...pool.charts].sort((a, b) => {
      const cmp = key === 'title' ? a.title.localeCompare(b.title) : a[key] - b[key];
      return cmp * sign;
    });
  }, [pool.charts, sort]);

  function toggleSort(key: SortKey): void {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: DEFAULT_DIR[key] };
      if (prev.dir === DEFAULT_DIR[key]) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return null; // third click on the same header: back to the pool's default order
    });
  }

  function header(key: SortKey, label: string): JSX.Element {
    const arrow = sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      <Table.Th onClick={() => toggleSort(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {label}
        {arrow}
      </Table.Th>
    );
  }

  return (
    <div>
      <Title order={3} size="h5" mb="xs">
        {poolLabel(pool.formatKey)}
      </Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            {header('title', 'Chart')}
            {header('vetoes', 'Vetoes')}
            {header('picks', 'Picks')}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r: PoolChartRow) => (
            <Table.Tr key={r.chartId}>
              <Table.Td>{r.title}</Table.Td>
              <Table.Td>{r.vetoes}</Table.Td>
              <Table.Td>{r.picks}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function SongPools({ pools }: { pools: PoolTally[] }): JSX.Element | null {
  if (pools.length === 0) return null;
  return (
    <div>
      <Title order={2} size="h4" mb="xs">
        Song Pools
      </Title>
      <Stack gap="md">
        {pools.map((pool) => (
          <SongPoolTable key={pool.formatKey} pool={pool} />
        ))}
      </Stack>
    </div>
  );
}

/**
 * DESIGN.md-style TO-facing review page — post-event protect/veto/pick
 * aggregates and timing, read-only. Organizer-tier only; a non-TO's fetch
 * 403s, same "controls stay present, server enforces the real gate"
 * convention `referee-overrides.tsx` documents — this tab isn't hidden,
 * the request behind it is what's actually gated.
 */
export default function TournamentAnalytics(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: analytics, isPending, error } = useQuery({
    queryKey: ['analytics', tournamentId],
    queryFn: () => fetchTournamentAnalytics(tournamentId!),
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
          Analytics needs a Discord sign-in so the server knows which tournaments you can act on.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 403) {
    content = (
      <Center h="60vh">
        <Alert color="yellow" title="Tournament Organizer tier required">
          You need Tournament Organizer tier in this server to view analytics.
        </Alert>
      </Center>
    );
  } else if (error || !analytics) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load analytics">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    content = (
      <>
        <Title order={2}>Analytics</Title>

        <Group gap="xl">
          <Text size="sm">
            <b>Started:</b> {formatDate(analytics.startedAt)}
          </Text>
          <Text size="sm">
            <b>Ended:</b> {formatDate(analytics.endedAt)}
          </Text>
          <Text size="sm">
            <b>Time elapsed:</b> {formatMinutes(analytics.elapsedMinutes)}
          </Text>
          <Text size="sm">
            <b>Average time per round:</b> {formatMinutes(analytics.averageRoundMinutes)}
          </Text>
          <Text size="sm">
            <b>Shortest match:</b> {formatMinutes(analytics.minMatchMinutes)}
          </Text>
          <Text size="sm">
            <b>Longest match:</b> {formatMinutes(analytics.maxMatchMinutes)}
          </Text>
        </Group>

        <ChartTallyTable title="Most Protected" countLabel="Protects" rows={analytics.mostProtectedCharts} />
        <SongPools pools={analytics.songPools} />
        <ChartTallyTable title="Most Vetoed (no song pool)" countLabel="Vetoes" rows={analytics.vetoedNoPool} />

        <div>
          <Title order={2} size="h4" mb="xs">
            Per Player
          </Title>
          {analytics.perPlayer.length === 0 ? (
            <Text size="sm" c="dimmed">
              No protect/veto/pick activity yet.
            </Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Player</Table.Th>
                  <Table.Th>Protects</Table.Th>
                  <Table.Th>Vetoes</Table.Th>
                  <Table.Th>Picks</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {analytics.perPlayer.map((p) => (
                  <Table.Tr key={p.entrantId}>
                    <Table.Td>{p.displayName ?? p.entrantId}</Table.Td>
                    <Table.Td>{p.protects}</Table.Td>
                    <Table.Td>{p.vetoes}</Table.Td>
                    <Table.Td>{p.picks}</Table.Td>
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
