import { sectionLabel } from '@itg/shared';
import type { BracketSide, Standings } from '@itg/shared';
import { Alert, Center, Loader, Select, Stack, Table, Title, VisuallyHidden } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MatchCell } from '../components/match-cell.js';
import { TournamentHeader } from '../components/tournament-header.js';
import { useBracketAnnouncements } from '../hooks/use-bracket-announcements.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';
import { useStandings } from '../hooks/use-standings.js';
import { useTournament } from '../hooks/use-tournament.js';
import { useVerbosity } from '../hooks/use-verbosity.js';
import { buildBracketLayout, type BracketColumn } from '../lib/bracket-layout.js';
import styles from './tournament-bracket.module.css';

/** "Tied players share a placement, and the next placement skips" — DESIGN.md, "Standings". Rendered exactly as `computeTournamentStandings` returns it, no re-derivation. */
function StandingsTable({ standings }: { standings: Standings }): JSX.Element {
  return (
    <div>
      <Title order={2} size="h3">
        Final Standings
      </Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Place</Table.Th>
            <Table.Th>Player</Table.Th>
            <Table.Th>Seed</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {standings.map((row) => (
            <Table.Tr key={row.entrantId}>
              <Table.Td>{row.place}</Table.Td>
              <Table.Td>{row.displayName}</Table.Td>
              <Table.Td>#{row.seed}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

/**
 * One side of the tree (winners or losers): a heading, then "an ordered
 * list of rounds, each containing an ordered list of matches" — DESIGN.md,
 * "Rendering the bracket". `hasActiveRound` hides the whole section on a
 * narrow viewport when the round selector points elsewhere, via CSS only.
 */
function BracketSection({
  title,
  tournamentId,
  columns,
  activeRoundIndex,
}: {
  title: string;
  tournamentId: string;
  columns: BracketColumn[];
  activeRoundIndex: number;
}): JSX.Element {
  return (
    <div className={styles.section} data-has-active={activeRoundIndex !== -1}>
      <Title order={2} size="h3">
        {title}
      </Title>
      <ol className={styles.side}>
        {columns.map((col, i) => (
          <li key={`${col.bracket}-${col.round}`} className={styles.round} data-active={i === activeRoundIndex}>
            <p className={styles.roundHeading}>{sectionLabel(col.bracket, col.round)}</p>
            <ol className={styles.matchList}>
              {col.matches.map((m) => (
                <MatchCell key={m.id} tournamentId={tournamentId} entry={m} />
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function TournamentBracket(): JSX.Element {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { data: snapshot, isPending, isError } = useTournament(tournamentId!);
  const { data: standings } = useStandings(tournamentId!);
  useRealtimeTournament(tournamentId!);
  const [verbosity, setVerbosity] = useVerbosity();
  const { log, politeLine } = useBracketAnnouncements(tournamentId!, snapshot, verbosity);

  // `generateBracket` (inside `buildBracketLayout`) requires at least 2
  // entrants — a tournament that hasn't started, or has no seeded entrants
  // yet, has no bracket to build at all, not a load failure.
  const layout = useMemo(() => (snapshot && snapshot.entrantCount >= 2 ? buildBracketLayout(snapshot) : null), [snapshot]);

  // One combined sequence across both sides plus the grand final, for the
  // narrow-viewport round selector — a phone watcher steps through in
  // order rather than picking a side first.
  const allSections = useMemo(() => {
    if (!layout) return [];
    const sections: { bracket: BracketSide; round: number }[] = [
      ...layout.winnersColumns.map((c) => ({ bracket: c.bracket, round: c.round })),
      ...layout.losersColumns.map((c) => ({ bracket: c.bracket, round: c.round })),
    ];
    if (layout.grandFinal) sections.push({ bracket: 'GRAND_FINAL', round: 1 });
    if (layout.grandFinalReset) sections.push({ bracket: 'GRAND_FINAL', round: 2 });
    return sections;
  }, [layout]);

  const [activeSection, setActiveSection] = useState(0);

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
        <Alert color="red" title="Couldn't load this tournament">
          Try again in a moment.
        </Alert>
      </Center>
    );
  } else if (!layout) {
    content = (
      <Center h="60vh">
        <Alert color="blue" title="Bracket not generated yet">
          {snapshot.name} hasn't started — the bracket appears once it does.
        </Alert>
      </Center>
    );
  } else {
    const current = allSections[activeSection];
    const winnersActiveIndex = current?.bracket === 'WINNERS' ? layout.winnersColumns.findIndex((c) => c.round === current.round) : -1;
    const losersActiveIndex = current?.bracket === 'LOSERS' ? layout.losersColumns.findIndex((c) => c.round === current.round) : -1;
    const grandFinalActive = current?.bracket === 'GRAND_FINAL';

    content = (
      <>
        {standings && standings.length > 0 && <StandingsTable standings={standings} />}

        <Select
          className={styles.roundSelector!}
          label="Round"
          value={String(activeSection)}
          onChange={(v) => v !== null && setActiveSection(Number(v))}
          data={allSections.map((s, i) => ({ value: String(i), label: sectionLabel(s.bracket, s.round) }))}
          allowDeselect={false}
        />

        <BracketSection title="Winners Bracket" tournamentId={tournamentId!} columns={layout.winnersColumns} activeRoundIndex={winnersActiveIndex} />

        {layout.losersColumns.length > 0 && (
          <BracketSection title="Losers Bracket" tournamentId={tournamentId!} columns={layout.losersColumns} activeRoundIndex={losersActiveIndex} />
        )}

        {(layout.grandFinal || layout.grandFinalReset) && (
          <div className={styles.section} data-has-active={grandFinalActive}>
            <Title order={2} size="h3">
              Grand Final
            </Title>
            <ol className={styles.matchList} style={{ maxWidth: 260 }}>
              {layout.grandFinal && <MatchCell tournamentId={tournamentId!} entry={layout.grandFinal} />}
              {layout.grandFinalReset && <MatchCell tournamentId={tournamentId!} entry={layout.grandFinalReset} />}
            </ol>
          </div>
        )}

        {/* Bracket-level events only — "a match completing, a player advancing, a walkover applied." Nothing else interrupts. */}
        <VisuallyHidden aria-live="polite" role="status">
          {politeLine}
        </VisuallyHidden>

        {/* Every change, browsed at the reader's own pace — never interrupts. */}
        <VisuallyHidden role="log" aria-label="Match updates">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </VisuallyHidden>

        <Select
          label="Announce"
          value={verbosity}
          onChange={(v) => v !== null && setVerbosity(v as 'all' | 'results' | 'off')}
          data={[
            { value: 'all', label: 'All updates' },
            { value: 'results', label: 'Results only' },
            { value: 'off', label: 'Off' },
          ]}
          allowDeselect={false}
          maw={200}
        />
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
