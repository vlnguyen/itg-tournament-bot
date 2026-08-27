import { ActionIcon, AppShell, Anchor, Button, Group, Text, Tooltip, useMantineColorScheme, useComputedColorScheme } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user.js';

/** Sun/moon/home as plain inline SVG rather than an icon-library dependency — Mantine itself ships no icons, and the app only needs these three. */
function HomeIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

function ColorSchemeToggle(): JSX.Element {
  const { setColorScheme } = useMantineColorScheme();
  // Resolves "auto" to the OS preference so the icon always shows what's
  // actually rendered, not the literal (possibly "auto") setting.
  const computed = useComputedColorScheme('dark');
  const next = computed === 'dark' ? 'light' : 'dark';

  return (
    <Tooltip label={`Switch to ${next} mode`}>
      <ActionIcon variant="default" size="lg" aria-label={`Switch to ${next} mode`} onClick={() => setColorScheme(next)}>
        {computed === 'dark' ? <SunIcon /> : <MoonIcon />}
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * "Sign-in is information, never a gate" — DESIGN.md. Every page works
 * fully signed out; this just shows whether a session exists and lets it
 * be started or ended. `/api/auth/login` is a real navigation (it chains
 * into Discord's own OAuth redirect), not a fetch.
 */
function SignInControl(): JSX.Element {
  const { data: discordUserId, isPending } = useCurrentUser();
  const queryClient = useQueryClient();

  if (isPending) return <div />;

  if (!discordUserId) {
    return (
      <Anchor href="/api/auth/login" size="sm">
        Sign in
      </Anchor>
    );
  }

  return (
    <Button
      variant="subtle"
      size="compact-sm"
      onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        await queryClient.invalidateQueries({ queryKey: ['current-user'] });
      }}
    >
      Sign out
    </Button>
  );
}

/** The one persistent chrome every route shares — the color-scheme toggle and sign-in state. */
export default function Layout(): JSX.Element {
  return (
    <AppShell header={{ height: 48 }} padding={0}>
      <AppShell.Header>
        <Group justify="space-between" h="100%" px="md" gap="md">
          <Anchor component={Link} to="/" underline="never" c="inherit">
            <Group gap="xs">
              <HomeIcon />
              <Text fw={700}>ITG Tournament Bot</Text>
            </Group>
          </Anchor>
          <Group gap="md">
            <SignInControl />
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
