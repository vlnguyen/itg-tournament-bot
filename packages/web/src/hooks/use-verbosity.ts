import { useEffect, useState } from 'react';

/**
 * "A three-way verbosity control — all updates / results only / off — is
 * persisted in localStorage, wrapped in try/catch and defaulting to
 * results only when storage is unavailable or empty." See DESIGN.md,
 * "What gets spoken".
 */
export type Verbosity = 'all' | 'results' | 'off';

const STORAGE_KEY = 'itg-bracket-verbosity';

function readStored(): Verbosity {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'all' || v === 'results' || v === 'off') return v;
  } catch {
    // storage unavailable — fall through to the default
  }
  return 'results';
}

export function useVerbosity(): [Verbosity, (v: Verbosity) => void] {
  const [verbosity, setVerbosity] = useState<Verbosity>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, verbosity);
    } catch {
      // best-effort only
    }
  }, [verbosity]);

  return [verbosity, setVerbosity];
}
