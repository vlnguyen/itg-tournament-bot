import type { PublicMatch } from '@itg/shared';
import { Alert, Badge, Center, Divider, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useParams } from 'react-router-dom';
import { RefereeOverrides } from '../components/referee-overrides.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useMatch } from '../hooks/use-match.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';

function nameOf(pub: PublicMatch, entrantId: string | undefined): string {
  return pub.participants.find((p) => p.entrantId === entrantId)?.displayName ?? '—';
}

function SongRow({ pub, song }: { pub: PublicMatch; song: PublicMatch['songs'][number] }): JSX.Element {
  const winnerText = !song.result
    ? '—'
    : song.result.winner === 'TIE'
      ? 'Tie'
      : song.result.winner === 'VOID'
        ? 'Void'
        : `${nameOf(pub, song.result.winner)} (${song.result.by === 'RULING' ? 'ruling' : 'agreed'})`;

  return (
    <Table.Tr>
      <Table.Td>{song.index + 1}</Table.Td>
      <Table.Td>
        {song.chart.title} [{song.chart.meter}]
      </Table.Td>
      <Table.Td>
        {pub.participants.map((p) => (
          <Text key={p.entrantId} size="sm">
            {p.displayName}: {song.ex[p.entrantId] ?? '—'}
          </Text>
        ))}
      </Table.Td>
      <Table.Td>{winnerText}</Table.Td>
    </Table.Tr>
  );
}

function pendingDescription(pub: PublicMatch): string {
  const p = pub.pending;
  switch (p.kind) {
    case 'SEED_CHOICE':
      return `Waiting on ${nameOf(pub, p.actor)} to choose Protect order.`;
    case 'PROTECT':
      return `Waiting on ${nameOf(pub, p.actor)} to Protect.`;
    case 'VETO':
      return `Waiting on ${nameOf(pub, p.actor)} to Veto.`;
    case 'SUBMIT_SCORE':
      return `Waiting on ${p.actors.map((a) => nameOf(pub, a)).join(' and ')} to submit EX%.`;
    case 'SELECT_WINNER':
      return `Waiting on ${p.actors.map((a) => nameOf(pub, a)).join(' and ')} to select the winner.`;
    case 'TIEBREAK_PICK':
      return `Waiting on a tiebreak pick.`;
    case 'CONFIRM_RESULT':
      return `Waiting on ${p.actors.map((a) => nameOf(pub, a)).join(' and ')} to confirm the result.`;
    case 'AWAITING_BOT':
      return 'The bot is drawing.';
    case 'AWAITING_TO':
      return 'Awaiting an organizer.';
    case 'DONE':
      return 'This match is decided.';
  }
}

export default function MatchDetail(): JSX.Element {
  const { tournamentId, matchId } = useParams<{ tournamentId: string; matchId: string }>();
  const { data: pub, isPending, isError } = useMatch(matchId!);
  const { data: discordUserId } = useCurrentUser();
  useRealtimeTournament(tournamentId!);

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
        <Alert color="red" title="Couldn't load this match">
          Try again in a moment.
        </Alert>
      </Center>
    );
  }

  const [p0, p1] = pub.participants;

  return (
    <Stack gap="lg" p="md">
      <div>
        <Title order={1}>
          {p0?.displayName ?? 'TBD'} vs {p1?.displayName ?? 'TBD'}
        </Title>
        <Group gap="xs">
          {p0 && (
            <Badge variant={pub.outcome?.placements.find((pl) => pl.entrantId === p0.entrantId)?.place === 1 ? 'filled' : 'light'}>
              {p0.displayName}: {pub.points[p0.entrantId] ?? 0}
            </Badge>
          )}
          {p1 && (
            <Badge variant={pub.outcome?.placements.find((pl) => pl.entrantId === p1.entrantId)?.place === 1 ? 'filled' : 'light'}>
              {p1.displayName}: {pub.points[p1.entrantId] ?? 0}
            </Badge>
          )}
        </Group>
      </div>

      {/* The status line doubles as this page's own polite live region — a viewer who opened this specific match hears its own updates. */}
      <Text fw={600} role="status" aria-live="polite">
        {pendingDescription(pub)}
      </Text>

      {pub.protects.length + pub.vetoes.length > 0 && (
        <div>
          <Title order={2} size="h4">
            Protect / Veto
          </Title>
          <Stack gap={4}>
            {[...pub.protects.map((a) => ({ ...a, kind: 'Protect' as const })), ...pub.vetoes.map((a) => ({ ...a, kind: 'Veto' as const }))]
              .sort((a, b) => pub.draw.findIndex((c) => c === pub.draw[a.drawIndex]) - pub.draw.findIndex((c) => c === pub.draw[b.drawIndex]))
              .map((a, i) => (
                <Text key={i} size="sm">
                  {nameOf(pub, a.by)} {a.kind === 'Protect' ? 'protected' : 'vetoed'} {pub.draw[a.drawIndex]?.title}
                </Text>
              ))}
          </Stack>
        </div>
      )}

      {pub.songs.length > 0 && (
        <div>
          <Title order={2} size="h4">
            Songs
          </Title>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Chart</Table.Th>
                <Table.Th>EX%</Table.Th>
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {pub.songs.map((song) => (
                <SongRow key={song.index} pub={pub} song={song} />
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}

      {pub.tiebreaks.length > 0 && (
        <div>
          <Title order={2} size="h4">
            Tiebreaks
          </Title>
          <Stack gap={4}>
            {pub.tiebreaks.map((t) => (
              <Text key={t.round} size="sm">
                Round {t.round}: {'chosenBy' in t ? `${t.chosenBy.length} of 2 picked` : ''}
                {'resolvedIndex' in t && t.charts[t.resolvedIndex] ? ` — playing ${t.charts[t.resolvedIndex]!.title}` : ''}
              </Text>
            ))}
          </Stack>
        </div>
      )}

      {pub.outcome && (
        <Alert color="green" title="Result">
          {pub.outcome.placements
            .sort((a, b) => a.place - b.place)
            .map((pl) => `${nameOf(pub, pl.entrantId)} (${pl.place === 1 ? 'winner' : 'runner-up'})`)
            .join(', ')}{' '}
          — {pub.outcome.by.toLowerCase()}
        </Alert>
      )}

      {discordUserId && (
        <>
          <Divider />
          <RefereeOverrides matchId={matchId!} pub={pub} />
        </>
      )}
    </Stack>
  );
}
