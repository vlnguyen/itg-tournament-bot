import { ActionIcon, AppShell, Group, Tooltip, useMantineColorScheme, useComputedColorScheme } from '@mantine/core';
import { Outlet } from 'react-router-dom';

/** Sun/moon as plain inline SVG rather than an icon-library dependency — the app only needs these two. */
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

/** The one persistent chrome every route shares — currently just the color-scheme toggle, per the user's request. */
export default function Layout(): JSX.Element {
  return (
    <AppShell header={{ height: 48 }} padding={0}>
      <AppShell.Header>
        <Group justify="flex-end" h="100%" px="md">
          <ColorSchemeToggle />
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
