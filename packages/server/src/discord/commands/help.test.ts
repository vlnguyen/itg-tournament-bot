import { ApplicationCommandOptionType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { collectEntries, SUBCOMMAND_GROUP } from './help.js';
import { commandDefinitions } from './definitions.js';

/**
 * Guards the one thing `/commands` can silently get wrong: a command or
 * subcommand that exists in `commandDefinitions` but has no group in
 * `help.ts`'s hand-kept maps — which `collectEntries` would otherwise just
 * drop rather than error on.
 */
describe('commandDefinitions grouping (/commands)', () => {
  it('lists every registered command and subcommand exactly once', () => {
    const expectedUsages: string[] = [];
    for (const builder of commandDefinitions) {
      const json = builder.toJSON();
      // Mirrors `collectEntries`'s own branch: a command is split subcommand
      // by subcommand only when it's listed in `SUBCOMMAND_GROUP` (mixed
      // gating) — `/setup` has subcommands too but is deliberately collapsed
      // to one whole-command line, since all three share one gate.
      if (SUBCOMMAND_GROUP[json.name]) {
        const subcommands = (json.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
        for (const sub of subcommands) expectedUsages.push(`/${json.name} ${sub.name}`);
      } else {
        expectedUsages.push(`/${json.name}`);
      }
    }

    const actualUsages = collectEntries().map((e) => e.usage);
    expect(new Set(actualUsages).size).toBe(actualUsages.length); // no duplicates
    expect(actualUsages.sort()).toEqual(expectedUsages.sort());
  });
});
