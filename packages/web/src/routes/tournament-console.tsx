import type { RunViewAlert } from '@itg/shared';
import { escalationReasonLabel } from '@itg/shared';
import { Alert, Anchor, Badge, Center, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';
import { useRunView } from '../hooks/use-run-view.js';
import { ApiError } from '../lib/api.js';
import { elapsedLabel } from '../lib/format-duration.js';

/** Ticks once a minute so `elapsedLabel` stays current without a per-second re-render. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function AlertRow({ tournamentId, alert, now }: { tournamentId: string; alert: RunViewAlert; now: number }): JSX.Element {
  const label = alert.kind === 'ESCALATION' ? escalationReasonLabel(alert.reason) : alert.alertKind;
  const matchLabel = alert.matchLabel ?? '-';
  const matchId = alert.kind === 'ESCALATION' ? alert.matchId : alert.matchId;

  return (
    <Table.Tr>
      <Table.Td>{matchLabel}</Table.Td>
      <Table.Td>{label}</Table.Td>
      <Table.Td>{elapsedLabel(alert.since, now)}</Table.Td>
      <Table.Td>
        {matchId ? (
          <Anchor component={Link} to={`/t/${tournamentId}/matches/${matchId}`} size="sm">
            Open in web UI
          </Anchor>
        ) : (
          <Text size="sm" c="dimmed">
            -
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

export default function TournamentConsole(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: discordUserId, isPending: userPending } = useCurrentUser();
  const { data: runView, isPending, error } = useRunView(tournamentId!);
  useRealtimeTournament(tournamentId!);
  const now = useNow();

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
          The organizer console needs a Discord sign-in so the server knows which tournaments you can act on.{' '}
          <Anchor href="/api/auth/login">Sign in</Anchor>.
        </Alert>
      </Center>
    );
  } else if (error instanceof ApiError && error.status === 403) {
    content = (
      <Center h="60vh">
        <Alert color="yellow" title="Referee tier required">
          You need Referee tier or above in this server to use the organizer console. Ask a Tournament Organizer to grant you the
          Referee role.
        </Alert>
      </Center>
    );
  } else if (error) {
    content = (
      <Center h="60vh">
        <Alert color="red" title="Couldn't load the run view">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    content = (
      <>
        <Title order={2}>Organizer Console</Title>

        <div>
          <Group gap="xs" mb="xs">
            <Title order={2} size="h3">
              Alert Queue
            </Title>
            {runView.alerts.length > 0 && <Badge color="red">{runView.alerts.length}</Badge>}
          </Group>
          {runView.alerts.length === 0 ? (
            <Text c="dimmed">Nothing waiting on a referee.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Match</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Waiting</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runView.alerts.map((a) => (
                  <AlertRow key={a.kind === 'ESCALATION' ? `e-${a.matchId}` : `t-${a.id}`} tournamentId={tournamentId!} alert={a} now={now} />
                ))}
              </Table.Tbody>
            </Table>
          )}
        </div>

        <div>
          <Title order={2} size="h3" mb="xs">
            Live Matches
          </Title>
          {runView.liveMatches.length === 0 ? (
            <Text c="dimmed">Nothing in progress right now.</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Match</Table.Th>
                  <Table.Th>Score</Table.Th>
                  <Table.Th>Current chart</Table.Th>
                  <Table.Th>Elapsed</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runView.liveMatches.map((m) => (
                  <Table.Tr key={m.matchId}>
                    <Table.Td>
                      <Anchor component={Link} to={`/t/${tournamentId}/matches/${m.matchId}`} size="sm">
                        {m.matchLabel}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      {m.participants.map((p) => (
                        <Text key={p.entrantId} size="sm">
                          {p.displayName}: {m.points[p.entrantId] ?? 0}
                        </Text>
                      ))}
                    </Table.Td>
                    <Table.Td>{m.currentChartTitle ?? '-'}</Table.Td>
                    <Table.Td>{elapsedLabel(m.since, now)}</Table.Td>
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
