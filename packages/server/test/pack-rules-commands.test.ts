import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { handlePack } from '../src/discord/commands/pack.js';
import { handleRules } from '../src/discord/commands/rules.js';
import type { CommandContext } from '../src/discord/commands/context.js';
import { cleanupTournament, isReachable, makeTournament, prisma, type TestTournament } from './support.js';

/** Only `ctx.prisma` and the interaction's guild-scoping/reply are ever touched by these two handlers. */
const ctx = { prisma } as CommandContext;

function fakeInteraction(guildId: string | null) {
  const replies: unknown[] = [];
  const interaction = {
    inGuild: () => guildId !== null,
    guildId,
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

describe.skipIf(!(await isReachable()))('/pack and /rules', () => {
  describe('outside a guild', () => {
    it('/pack refuses', async () => {
      const { interaction, replies } = fakeInteraction(null);
      await handlePack(interaction, ctx);
      expect(replies).toEqual([{ ephemeral: true, content: 'This only works inside a server.' }]);
    });

    it('/rules refuses', async () => {
      const { interaction, replies } = fakeInteraction(null);
      await handleRules(interaction, ctx);
      expect(replies).toEqual([{ ephemeral: true, content: 'This only works inside a server.' }]);
    });
  });

  describe('no tournament running', () => {
    it('/pack says so', async () => {
      const { interaction, replies } = fakeInteraction('no-such-guild');
      await handlePack(interaction, ctx);
      expect(replies).toEqual([{ ephemeral: true, content: "There's no tournament running." }]);
    });

    it('/rules says so', async () => {
      const { interaction, replies } = fakeInteraction('no-such-guild');
      await handleRules(interaction, ctx);
      expect(replies).toEqual([{ ephemeral: true, content: "There's no tournament running." }]);
    });
  });

  describe('a running tournament with no packUrl/rules set', () => {
    it('/pack omits the download line', async () => {
      const t: TestTournament = await makeTournament(`pack-unset-${Date.now()}`, 2);
      try {
        const { interaction, replies } = fakeInteraction(t.guildId);
        await handlePack(interaction, ctx);
        const reply = replies[0] as { content: string };
        expect(reply.content).not.toContain('Download:');
        expect(reply.content).toContain('/pack');
      } finally {
        await cleanupTournament(t);
      }
    });

    it('/rules says none have been posted', async () => {
      const t: TestTournament = await makeTournament(`rules-unset-${Date.now()}`, 2);
      try {
        const { interaction, replies } = fakeInteraction(t.guildId);
        await handleRules(interaction, ctx);
        expect(replies).toEqual([{ ephemeral: true, content: 'No rules have been posted for this tournament yet.' }]);
      } finally {
        await cleanupTournament(t);
      }
    });
  });

  describe('a running tournament with packUrl/rules set', () => {
    it('/pack appends the download link', async () => {
      const t: TestTournament = await makeTournament(`pack-set-${Date.now()}`, 2);
      try {
        await prisma.tournament.update({ where: { id: t.tournamentId }, data: { packUrl: 'https://example.com/pack.zip' } });
        const { interaction, replies } = fakeInteraction(t.guildId);
        await handlePack(interaction, ctx);
        const reply = replies[0] as { content: string };
        expect(reply.content).toContain('Download: https://example.com/pack.zip');
      } finally {
        await cleanupTournament(t);
      }
    });

    it('/rules replies with the posted rules text', async () => {
      const t: TestTournament = await makeTournament(`rules-set-${Date.now()}`, 2);
      try {
        await prisma.tournament.update({ where: { id: t.tournamentId }, data: { rules: 'No CMod. No turntable.' } });
        const { interaction, replies } = fakeInteraction(t.guildId);
        await handleRules(interaction, ctx);
        const reply = replies[0] as { embeds: { data: { description?: string } }[] };
        expect(reply.embeds[0]!.data.description).toBe('No CMod. No turntable.');
      } finally {
        await cleanupTournament(t);
      }
    });
  });
});
