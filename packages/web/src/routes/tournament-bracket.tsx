import { canEditMatchFormat, FORMAT_LABEL, FORMAT_SHORT_LABEL, FormatKey, matchKey, sectionLabel, SELECTABLE_FORMAT_KEYS } from '@itg/shared';
import type { BracketShape, BracketSide, MatchRef, Standings } from '@itg/shared';
import { Alert, Button, Center, Group, Loader, Select, Stack, Table, Text, Title, VisuallyHidden } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MatchCell } from '../components/match-cell.js';
import { TournamentHeader } from '../components/tournament-header.js';
import { useBracketAnnouncements } from '../hooks/use-bracket-announcements.js';
import { useLifecycleStatus } from '../hooks/use-lifecycle-status.js';
import { useRealtimeRoster } from '../hooks/use-realtime-roster.js';
import { useRealtimeTournament } from '../hooks/use-realtime-tournament.js';
import { useRoster } from '../hooks/use-roster.js';
import { useStandings } from '../hooks/use-standings.js';
import { useTournament } from '../hooks/use-tournament.js';
import { useVerbosity } from '../hooks/use-verbosity.js';
import { buildBracketLayout, projectRoundOne, type BracketColumn, type ProjectedSlot } from '../lib/bracket-layout.js';
import { ApiError, submitMatchFormats } from '../lib/api.js';
import styles from './tournament-bracket.module.css';

/** "Tied players share a placement, and the next placement skips" — DESIGN.md, "Standings". Rendered exactly as `computeTournamentStandings` returns it, no re-derivation. */
function StandingsTable({ standings }: { standings: Standings }): JSX.Element {
  return (
    <div>
      <Title order={2} size="h3">
        Standings
      </Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: '1%', whiteSpace: 'nowrap' }}>Place</Table.Th>
            <Table.Th>Player</Table.Th>
            <Table.Th style={{ width: '1%', whiteSpace: 'nowrap' }}>Seed</Table.Th>
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

const FORMAT_SELECT_DATA = SELECTABLE_FORMAT_KEYS.map((k) => ({ value: k, label: FORMAT_SHORT_LABEL[k] }));

/**
 * One side of the tree (winners or losers): a heading, then "an ordered
 * list of rounds, each containing an ordered list of matches" — DESIGN.md,
 * "Rendering the bracket". `hasActiveRound` hides the whole section on a
 * narrow viewport when the round selector points elsewhere, via CSS only.
 *
 * `onAssignRound` fires-and-forgets a format onto every match in one round
 * at once — the one-click path for the common "Bo5 for the whole Winners
 * Finals round" case. It's deliberately uncontrolled (no persisted `value`):
 * a round's matches can be edited individually afterward, so showing one
 * fixed value would imply a uniformity the round no longer has to keep.
 */
function BracketSection({
  title,
  tournamentId,
  columns,
  shape,
  activeRoundIndex,
  canEditFormats,
  selected,
  onToggleSelect,
  onAssignRound,
  projections,
}: {
  title: string;
  tournamentId: string;
  columns: BracketColumn[];
  shape: BracketShape;
  activeRoundIndex: number;
  /** Organizer-only *and* only before the tournament starts — see `canEditMatchFormat`. */
  canEditFormats: boolean;
  selected: Map<string, MatchRef>;
  onToggleSelect: (ref: MatchRef) => void;
  onAssignRound: (refs: MatchRef[], formatKey: FormatKey) => void;
  /** Round-1-only seed-order preview — see `projectRoundOne`. Looked up by `matchKey`, so a round-2+ lookup simply misses. */
  projections: Map<string, [ProjectedSlot | undefined, ProjectedSlot | undefined]>;
}): JSX.Element {
  return (
    <div className={styles.section} data-has-active={activeRoundIndex !== -1}>
      <Title order={2} size="h3">
        {title}
      </Title>
      <ol className={styles.side}>
        {columns.map((col, i) => (
          <li key={`${col.bracket}-${col.round}`} className={styles.round} data-active={i === activeRoundIndex}>
            <Group gap="xs" wrap="nowrap" align="center">
              <p className={styles.roundHeading}>{sectionLabel(col.bracket, col.round, shape)}</p>
              {canEditFormats && col.matches.length > 0 && (
                <Select
                  size="xs"
                  w={90}
                  placeholder="Set…"
                  data={FORMAT_SELECT_DATA}
                  onChange={(v) => v && onAssignRound(col.matches.map((m) => ({ bracket: m.bracket, round: m.round, slot: m.slot })), v as FormatKey)}
                />
              )}
            </Group>
            <ol className={styles.matchList}>
              {col.matches.map((m) => (
                <MatchCell
                  key={m.id}
                  tournamentId={tournamentId}
                  entry={m}
                  selection={
                    canEditFormats
                      ? { checked: selected.has(matchKey({ bracket: m.bracket, round: m.round, slot: m.slot })), onToggle: () => onToggleSelect({ bracket: m.bracket, round: m.round, slot: m.slot }) }
                      : undefined
                  }
                  projected={projections.get(matchKey({ bracket: m.bracket, round: m.round, slot: m.slot }))}
                />
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
  const { data: lifecycleStatus } = useLifecycleStatus(tournamentId!);
  const isOrganizer = lifecycleStatus !== undefined;
  // Format-assignment controls (the round "Set…" Select, per-match
  // selection checkboxes) are organizer-only *and* locked once the
  // tournament has started — same as `match-detail.tsx`'s own format
  // `Select`. A still-`PENDING` future match doesn't exempt it: the
  // tournament as a whole having started is what locks it.
  const canEditFormats = isOrganizer && !!snapshot && canEditMatchFormat(snapshot.state);
  // Organizer-only, same gate as `/roster` itself — a spectator's seat is
  // never a projection target, so there's nothing to fetch for one.
  const { data: roster } = useRoster(tournamentId!, isOrganizer);
  useRealtimeRoster(tournamentId!);
  const queryClient = useQueryClient();
  useRealtimeTournament(tournamentId!);
  const [verbosity, setVerbosity] = useVerbosity();
  const { log, politeLine } = useBracketAnnouncements(tournamentId!, snapshot, verbosity);

  // matchKey(ref) -> ref, so a selection can be both a membership test and
  // the payload `submitMatchFormats` needs, without re-parsing the key.
  const [selected, setSelected] = useState<Map<string, MatchRef>>(new Map());
  const toggleSelect = (ref: MatchRef): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = matchKey(ref);
      if (next.has(key)) next.delete(key);
      else next.set(key, ref);
      return next;
    });
  };

  const assignMutation = useMutation({
    mutationFn: ({ refs, formatKey }: { refs: MatchRef[]; formatKey: FormatKey }) => submitMatchFormats(tournamentId!, refs, formatKey),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['tournament', tournamentId] });
      // Only clear the selection for a multi-select apply — a per-round
      // quick-assign never touched it.
      setSelected((prev) => {
        const next = new Map(prev);
        for (const ref of variables.refs) next.delete(matchKey(ref));
        return next;
      });
    },
  });

  // `generateBracket` (inside `buildBracketLayout`) requires at least 2
  // entrants — a tournament that hasn't started, or has no seeded entrants
  // yet, has no bracket to build at all, not a load failure.
  const layout = useMemo(() => (snapshot && snapshot.entrantCount >= 2 ? buildBracketLayout(snapshot) : null), [snapshot]);

  // Recomputed on every roster change — `useRealtimeRoster` above invalidates
  // the roster query the moment a TO reorders seeds anywhere (web or
  // Discord), so this stays live without any bracket-specific socket event.
  const projections = useMemo(() => (layout && roster ? projectRoundOne(layout.generated, roster) : new Map()), [layout, roster]);

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
          {snapshot.name} hasn't started. The bracket appears once it does.
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

        {assignMutation.isError && (
          <Alert color="red" title="Couldn't set the format">
            {assignMutation.error instanceof ApiError ? assignMutation.error.message : 'Something went wrong.'}
          </Alert>
        )}

        {canEditFormats && selected.size > 0 && (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">{selected.size} match(es) selected</Text>
            <Select
              size="xs"
              w={220}
              placeholder="Set selected to…"
              data={SELECTABLE_FORMAT_KEYS.map((k) => ({ value: k, label: FORMAT_LABEL[k] }))}
              disabled={assignMutation.isPending}
              onChange={(v) => v && assignMutation.mutate({ refs: [...selected.values()], formatKey: v as FormatKey })}
            />
            <Button size="xs" variant="subtle" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
          </Group>
        )}

        <Select
          className={styles.roundSelector!}
          label="Round"
          value={String(activeSection)}
          onChange={(v) => v !== null && setActiveSection(Number(v))}
          data={allSections.map((s, i) => ({ value: String(i), label: sectionLabel(s.bracket, s.round, layout.generated) }))}
          allowDeselect={false}
        />

        <BracketSection
          title="Winners Bracket"
          tournamentId={tournamentId!}
          columns={layout.winnersColumns}
          shape={layout.generated}
          activeRoundIndex={winnersActiveIndex}
          canEditFormats={canEditFormats}
          selected={selected}
          onToggleSelect={toggleSelect}
          onAssignRound={(refs, formatKey) => assignMutation.mutate({ refs, formatKey })}
          projections={projections}
        />

        {layout.losersColumns.length > 0 && (
          <BracketSection
            title="Losers Bracket"
            tournamentId={tournamentId!}
            columns={layout.losersColumns}
            shape={layout.generated}
            activeRoundIndex={losersActiveIndex}
            canEditFormats={canEditFormats}
            selected={selected}
            onToggleSelect={toggleSelect}
            onAssignRound={(refs, formatKey) => assignMutation.mutate({ refs, formatKey })}
            projections={projections}
          />
        )}

        {(layout.grandFinal || layout.grandFinalReset) && (
          <div className={styles.section} data-has-active={grandFinalActive}>
            <Title order={2} size="h3">
              Grand Finals Bracket
            </Title>
            <ol className={`${styles.side} ${styles.grandFinalSide}`}>
              {layout.grandFinal && (
                <li className={`${styles.round} ${styles.grandFinalRound}`}>
                  <Group gap="xs" wrap="nowrap" align="center">
                    <p className={styles.roundHeading}>{sectionLabel('GRAND_FINAL', 1)}</p>
                    {canEditFormats && (
                      <Select
                        size="xs"
                        w={90}
                        placeholder="Set…"
                        data={FORMAT_SELECT_DATA}
                        onChange={(v) => v && assignMutation.mutate({ refs: [{ bracket: 'GRAND_FINAL', round: 1, slot: layout.grandFinal!.slot }], formatKey: v as FormatKey })}
                      />
                    )}
                  </Group>
                  <ol className={styles.matchList} style={{ maxWidth: 260 }}>
                    <MatchCell
                      tournamentId={tournamentId!}
                      entry={layout.grandFinal}
                      selection={canEditFormats ? { checked: selected.has('GRAND_FINAL:1:0'), onToggle: () => toggleSelect({ bracket: 'GRAND_FINAL', round: 1, slot: layout.grandFinal!.slot }) } : undefined}
                    />
                  </ol>
                </li>
              )}
              {layout.grandFinalReset && (
                <li className={`${styles.round} ${styles.grandFinalRound}`}>
                  <Group gap="xs" wrap="nowrap" align="center">
                    <p className={styles.roundHeading}>{sectionLabel('GRAND_FINAL', 2)}</p>
                    {canEditFormats && (
                      <Select
                        size="xs"
                        w={90}
                        placeholder="Set…"
                        data={FORMAT_SELECT_DATA}
                        onChange={(v) => v && assignMutation.mutate({ refs: [{ bracket: 'GRAND_FINAL', round: 2, slot: layout.grandFinalReset!.slot }], formatKey: v as FormatKey })}
                      />
                    )}
                  </Group>
                  <ol className={styles.matchList} style={{ maxWidth: 260 }}>
                    <MatchCell
                      tournamentId={tournamentId!}
                      entry={layout.grandFinalReset}
                      selection={
                        canEditFormats ? { checked: selected.has('GRAND_FINAL:2:0'), onToggle: () => toggleSelect({ bracket: 'GRAND_FINAL', round: 2, slot: layout.grandFinalReset!.slot }) } : undefined
                      }
                    />
                  </ol>
                </li>
              )}
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
          label="Announce (Screen Reader)"
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
