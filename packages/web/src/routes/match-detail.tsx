import type { PublicMatch } from '@itg/shared';
import { canEditMatchFormat, displayStepartistLine, displayTitle, FORMAT_LABEL, FormatKey, generateBracket, playstylePrefix, sectionLabel, SELECTABLE_FORMAT_KEYS } from '@itg/shared';
import { Alert, Badge, Center, Divider, Group, Loader, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { RefereeOverrides } from '../components/referee-overrides.js';
import { TournamentHeader } from '../components/tournament-header.js';
import { useCurrentUser } from '../hooks/use-current-user.js';
import { useLifecycleStatus } from '../hooks/use-lifecycle-status.js';
import { useMatch } from '../hooks/use-match.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';
import { useTournament } from '../hooks/use-tournament.js';
import { ApiError, submitMatchFormats } from '../lib/api.js';

function nameOf(pub: PublicMatch, entrantId: string | undefined): string {
  return pub.participants.find((p) => p.entrantId === entrantId)?.displayName ?? '-';
}

/** Who picked this song, Hubert's formats only — `undefined` for a forced Tiebreaker (never a player pick) or any Bo3/Bo5 song (`pub.picks` is always `[]` there). */
export function pickedBy(pub: PublicMatch, song: PublicMatch['songs'][number]): string | undefined {
  if (song.drawIndex === undefined) return undefined;
  return pub.picks.find((p) => p.drawIndex === song.drawIndex)?.by;
}

function SongRow({ pub, song, showPickedBy }: { pub: PublicMatch; song: PublicMatch['songs'][number]; showPickedBy: boolean }): JSX.Element {
  const winnerText = !song.result
    ? '-'
    : song.result.winner === 'TIE'
      ? 'Tie'
      : song.result.winner === 'VOID'
        ? 'Void'
        : `${nameOf(pub, song.result.winner)}${song.result.by === 'RULING' ? ' (ruling)' : ''}`;

  return (
    <Table.Tr>
      <Table.Td>{song.chart.poolLabel ?? song.index + 1}</Table.Td>
      <Table.Td>
        {song.chart.title} [{song.chart.meter}]
      </Table.Td>
      {showPickedBy && <Table.Td>{nameOf(pub, pickedBy(pub, song))}</Table.Td>}
      <Table.Td>
        {pub.participants.map((p) => (
          <Text key={p.entrantId} size="sm">
            {p.displayName}: {song.ex[p.entrantId] !== undefined ? `${song.ex[p.entrantId]!.toFixed(2)}%` : '-'}
          </Text>
        ))}
      </Table.Td>
      <Table.Td>{winnerText}</Table.Td>
    </Table.Tr>
  );
}

/** One drawn chart's fate — protected, vetoed, the decider, played, or still undetermined (mid-sequence). */
function drawStatus(pub: PublicMatch, drawIndex: number): string | null {
  const protect = pub.protects.find((p) => p.drawIndex === drawIndex);
  if (protect) return `Protected by ${nameOf(pub, protect.by)}`;
  const veto = pub.vetoes.find((v) => v.drawIndex === drawIndex);
  if (veto) return `Vetoed by ${nameOf(pub, veto.by)}`;
  if (pub.deciderIndex === drawIndex) return 'Decider';
  return null;
}

/** A static-pool format (Hubert's formats) labels every chart in the Draw — the label is a unique identifier, so it replaces the position number everywhere this match's charts are shown. Bo3/Bo5 never set `poolLabel`, so this is `false` for them, same check `buildDrawEmbed` makes server-side. */
export function isStaticPool(draw: PublicMatch['draw']): boolean {
  return draw.length > 0 && draw.every((c) => c.poolLabel !== null);
}

function DrawSection({ pub }: { pub: PublicMatch }): JSX.Element {
  const labeled = isStaticPool(pub.draw);
  return (
    <div>
      <Title order={2} size="h4">
        {labeled ? 'Song Pool' : 'Draw'}
      </Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: '1%', whiteSpace: 'nowrap' }}>#</Table.Th>
            <Table.Th>Chart</Table.Th>
            <Table.Th>Level</Table.Th>
            <Table.Th>Description</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {pub.draw.map((chart, i) => {
            const played = pub.songs.find((s) => s.drawIndex === i);
            const status = played ? 'Played' : drawStatus(pub, i);
            return (
              <Table.Tr key={chart.chartId}>
                <Table.Td>{chart.poolLabel ?? i + 1}</Table.Td>
                <Table.Td>{displayTitle(chart)}</Table.Td>
                <Table.Td>
                  {playstylePrefix(chart.playStyle, chart.difficulty)}
                  {chart.meter}
                </Table.Td>
                <Table.Td>{displayStepartistLine(chart)}</Table.Td>
                <Table.Td>{status ?? <Text c="dimmed">-</Text>}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </div>
  );
}

/**
 * "The state message shows who has acted, never what they picked" —
 * DESIGN.md, "The tiebreak" — is enforced by the wire schema itself:
 * `choices`/`resolvedIndex` are simply absent from `PublicTiebreakRound`
 * until both picks land, so there's nothing here to accidentally leak
 * before then. `chosenBy` (who has acted) stays visible either way.
 */
function TiebreakRoundSection({ t, pub }: { t: PublicMatch['tiebreaks'][number]; pub: PublicMatch }): JSX.Element {
  const resolved = 'resolvedIndex' in t;

  return (
    <div>
      <Text fw={600} size="sm" mb={4}>
        Round {t.round}
      </Text>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: '1%', minWidth: '4.5em', whiteSpace: 'nowrap' }}>#</Table.Th>
            <Table.Th>Chart</Table.Th>
            <Table.Th>Level</Table.Th>
            <Table.Th>{resolved ? 'Voted for by' : 'Status'}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {t.charts.map((chart, i) => (
            <Table.Tr key={chart.chartId}>
              <Table.Td>
                {i + 1}
                {resolved && i === t.resolvedIndex ? ' 🎯' : ''}
              </Table.Td>
              <Table.Td>{displayTitle(chart)}</Table.Td>
              <Table.Td>
                {playstylePrefix(chart.playStyle, chart.difficulty)}
                {chart.meter}
              </Table.Td>
              <Table.Td>
                {resolved ? (
                  pub.participants
                    .filter((p) => t.choices[p.entrantId] === i)
                    .map((p) => p.displayName)
                    .join(', ') || <Text c="dimmed">-</Text>
                ) : (
                  <Text c="dimmed">-</Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {!resolved && (
        <Text size="sm" c="dimmed" mt={4}>
          {pub.participants.map((p) => `${p.displayName}: ${t.chosenBy.includes(p.entrantId) ? 'picked' : 'not yet'}`).join(' · ')}
        </Text>
      )}
    </div>
  );
}

/** `POINTS` reads as the ordinary case (the score already says it) and gets no callout — mirrors `result-summary.ts`'s `WIN_CONDITION_LABEL` on the Discord side. */
const WIN_CONDITION_LABEL: Record<'POINTS' | 'TIEBREAKER' | 'AVG_EX', string> = {
  POINTS: '',
  TIEBREAKER: 'won by points, song pool exhausted',
  AVG_EX: 'won on average EX%',
};

/** `outcome.winCondition` is only ever set alongside `by === 'AGREEMENT'`. */
function decidedByText(outcome: NonNullable<PublicMatch['outcome']>): string {
  if (outcome.winCondition) return WIN_CONDITION_LABEL[outcome.winCondition];
  return outcome.by === 'AGREEMENT' ? '' : outcome.by.toLowerCase();
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
    case 'SELECT_SONG':
      return `Waiting on ${nameOf(pub, p.actor)} to pick the next song.`;
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
  const { data: lifecycleStatus } = useLifecycleStatus(tournamentId!);
  const isOrganizer = lifecycleStatus !== undefined;
  const queryClient = useQueryClient();
  useRealtimeTournament(tournamentId!);

  // Upgrades `sectionLabel`'s plain "Winners Round 1" to "Winners
  // Semifinals" etc., same as the bracket page's own round headings —
  // requires the bracket's shape, not just this one match's own
  // bracket/round. A match page is only ever reached once a bracket
  // exists, so `entrantCount >= 2` always holds here; guarded anyway to
  // match `tournament-bracket.tsx`'s own precedent for `generateBracket`.
  const { data: snapshot } = useTournament(tournamentId!);
  const shape = snapshot && snapshot.entrantCount >= 2 ? generateBracket(snapshot.entrantCount) : undefined;

  // `pub.seq === 0` is the same "nothing has happened yet" test
  // `deriveMatchStatus` uses server-side for `PENDING` — `setMatchFormats`
  // refuses anything past that point, so the Select doesn't offer what
  // would just come back as an error.
  const formatMutation = useMutation({
    mutationFn: (formatKey: FormatKey) =>
      submitMatchFormats(tournamentId!, [{ bracket: pub!.bracket, round: pub!.round, slot: pub!.slot }], formatKey),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['match', matchId] }),
  });

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
        <Alert color="red" title="Couldn't load this match">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else {
    const [p0, p1] = pub.participants;
    // One slot was never real, not merely unfilled yet — see
    // `match-cell.tsx`'s own bye handling. Only one seat is ever seated
    // for a bye, so "vs TBD" would be misleading here the same way it
    // would be on the bracket cell.
    const isBye = pub.participants.length < 2 && pub.outcome?.by === 'WALKOVER';
    const labeled = isStaticPool(pub.draw);

    content = (
      <>
        <div>
          <Title order={1}>
            {isBye ? `${p0?.displayName ?? p1?.displayName ?? 'TBD'} (BYE)` : `${p0?.displayName ?? 'TBD'} vs ${p1?.displayName ?? 'TBD'}`}
          </Title>
          <Group gap="xs" align="center">
            <Text c="dimmed">{sectionLabel(pub.bracket, pub.round, shape)}</Text>
            <Text c="dimmed">&middot;</Text>
            {isOrganizer && pub.seq === 0 && snapshot && canEditMatchFormat(snapshot.state) ? (
              <Select
                size="xs"
                w={210}
                data={SELECTABLE_FORMAT_KEYS.map((k) => ({ value: k, label: FORMAT_LABEL[k] }))}
                value={pub.formatKey}
                allowDeselect={false}
                disabled={formatMutation.isPending}
                onChange={(v) => v && formatMutation.mutate(v as FormatKey)}
                aria-label="Match format"
              />
            ) : (
              <Text c="dimmed">{FORMAT_LABEL[pub.formatKey]}</Text>
            )}
          </Group>
          {formatMutation.isError && (
            <Text size="xs" c="red">
              {formatMutation.error instanceof ApiError ? formatMutation.error.message : "Couldn't change the format."}
            </Text>
          )}
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

        {pub.draw.length > 0 && <DrawSection pub={pub} />}

        {pub.protects.length + pub.vetoes.length > 0 && (
          <div>
            <Title order={2} size="h4">
              Protect / Veto
            </Title>
            <Stack gap={4}>
              {[...pub.protects.map((a) => ({ ...a, kind: 'Protect' as const })), ...pub.vetoes.map((a) => ({ ...a, kind: 'Veto' as const }))]
                .sort((a, b) => pub.draw.findIndex((c) => c === pub.draw[a.drawIndex]) - pub.draw.findIndex((c) => c === pub.draw[b.drawIndex]))
                .map((a, i) => {
                  const chart = pub.draw[a.drawIndex];
                  const chartLabel = chart?.poolLabel ? `${chart.poolLabel}: ${chart.title}` : chart?.title;
                  return (
                    <Text key={i} size="sm">
                      {nameOf(pub, a.by)} {a.kind === 'Protect' ? 'protected' : 'vetoed'} {chartLabel}
                    </Text>
                  );
                })}
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
                  <Table.Th style={{ width: '1%', whiteSpace: 'nowrap' }}>#</Table.Th>
                  <Table.Th>Chart</Table.Th>
                  {labeled && <Table.Th>Picked by</Table.Th>}
                  <Table.Th>EX%</Table.Th>
                  <Table.Th>Result</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pub.songs.map((song) => (
                  <SongRow key={song.index} pub={pub} song={song} showPickedBy={labeled} />
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
            <Stack gap="md">
              {pub.tiebreaks.map((t) => (
                <TiebreakRoundSection key={t.round} t={t} pub={pub} />
              ))}
            </Stack>
          </div>
        )}

        {pub.outcome && (
          <Alert color="green" title="Result">
            {pub.outcome.placements
              .sort((a, b) => a.place - b.place)
              .map((pl) => `${nameOf(pub, pl.entrantId)} (${pl.place === 1 ? 'winner' : 'runner-up'})`)
              .join(', ')}
            {decidedByText(pub.outcome) && ` (${decidedByText(pub.outcome)})`}
          </Alert>
        )}

        {discordUserId && (
          <>
            <Divider />
            <RefereeOverrides matchId={matchId!} pub={pub} />
          </>
        )}
      </>
    );
  }

  return (
    <Stack gap="lg" p="md">
      <TournamentHeader tournamentId={tournamentId!} />
      {content}
    </Stack>
  );
}
