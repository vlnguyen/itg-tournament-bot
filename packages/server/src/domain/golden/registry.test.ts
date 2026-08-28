import { describe, expect, it } from 'vitest';
import { FormatKey } from '@itg/shared';
import { formatRegistry } from './registry.js';

/**
 * `FormatKey` (`@itg/shared`) is what a picker offers; `formatRegistry` is
 * what actually resolves. The two are maintained by hand in separate
 * packages — the domain layer can't depend on shared's zod schema without
 * risking a cycle, and shared can't import server-only domain code — so
 * this is the guard that keeps them from drifting apart.
 */
describe('FormatKey and formatRegistry agree', () => {
  it('every FormatKey option resolves in formatRegistry', () => {
    for (const key of FormatKey.options) {
      expect(formatRegistry[key], `"${key}" is a FormatKey option but not registered`).toBeDefined();
    }
  });

  it('every registered format has a FormatKey option', () => {
    const registered = Object.keys(formatRegistry);
    const known = new Set<string>(FormatKey.options);
    for (const key of registered) {
      expect(known.has(key), `"${key}" is registered but not a FormatKey option`).toBe(true);
    }
  });
});
