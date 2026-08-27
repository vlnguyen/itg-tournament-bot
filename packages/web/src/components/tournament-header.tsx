import type { TournamentState } from '@itg/shared';
import { Anchor, Badge, Group, Stack, Text, Title } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';
import { useTournament } from '../hooks/use-tournament.js';

export const STATE_LABEL: Record<TournamentState, string> = {
  DRAFT: 'Draft',
  REGISTRATION_OPEN: 'Registration Open',
  REGISTRATION_CLOSED: 'Registration Closed',
  CHECKIN_OPEN: 'Check-in Open',
  CHECKIN_CLOSED: 'Check-in Closed',
  RUNNING: 'Running',
  COMPLETE: 'Complete',
  CANCELLED: 'Cancelled',
};

export const STATE_COLOR: Partial<Record<TournamentState, string>> = {
  DRAFT: 'gray',
  RUNNING: 'yellow',
  COMPLETE: 'green',
  CANCELLED: 'red',
};

const TABS: { path: string; label: string }[] = [
  { path: '', label: 'Standings/Bracket' },
  { path: '/pack', label: 'Song Pack' },
  { path: '/console', label: 'Organizer Console' },
  { path: '/roster', label: 'Seeding' },
  { path: '/config', label: 'Configuration' },
];

/**
 * The one piece of chrome every tournament-scoped page shares — the
 * tournament's name and current state above a nav linking to the other
 * pages, always rendered even on a loading/sign-in/tier-gated page so a
 * page that can't show its own content yet still offers a way to the
 * others. Fetched via `useTournament` — the same public, unauthenticated
 * query the bracket page already uses — so this header itself never
 * needs a sign-in to render, regardless of which page hosts it.
 *
 * Referee/TO-only pages are listed unconditionally: each one gates on
 * the signed-in user's own tier, per DESIGN.md's "what a person sees is
 * filtered by tierOf, not by which console they opened."
 *
 * `showGuild` adds a subtitle naming and linking to the tournament's own
 * server (`/g/:guildId`) — off by default, since most pages here are only
 * ever reached by navigating within that server's own context already; a
 * match detail page is the one place someone plausibly lands from an
 * out-of-context link (a Discord message shared standalone) and needs
 * "which server is this" spelled out.
 */
export function TournamentHeader({ tournamentId, showGuild = false }: { tournamentId: string; showGuild?: boolean }): JSX.Element {
  const { data: snapshot } = useTournament(tournamentId);
  const { pathname } = useLocation();

  return (
    <Stack gap={4}>
      {snapshot && (
        <div>
          <Group gap="xs" align="center">
            <Title order={1}>{snapshot.name}</Title>
            <Badge size="lg" {...(STATE_COLOR[snapshot.state] ? { color: STATE_COLOR[snapshot.state] } : {})}>
              {STATE_LABEL[snapshot.state]}
            </Badge>
          </Group>
          {showGuild && (
            <Text size="sm" c="dimmed">
              <Anchor component={Link} to={`/g/${snapshot.guildId}`} c="dimmed">
                {snapshot.guildName}
              </Anchor>
            </Text>
          )}
        </div>
      )}

      <Group gap="md" component="nav" aria-label="Tournament pages">
        {TABS.map((tab) => {
          const href = `/t/${tournamentId}${tab.path}`;
          const active = pathname === href;
          return (
            <Anchor key={tab.path} component={Link} to={href} size="sm" fw={active ? 700 : 400} aria-current={active ? 'page' : undefined}>
              {tab.label}
            </Anchor>
          );
        })}
      </Group>
    </Stack>
  );
}
