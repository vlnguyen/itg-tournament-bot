import { afterEach, describe, expect, it } from 'vitest';
import { resolvePublicLandingTournament } from '../src/services/tournament-service.js';
import { isReachable, prisma } from './support.js';

/**
 * `resolvePublicLandingTournament` backs the server landing-page redirect
 * (DESIGN.md, "Permanent URLs") — distinct from `findActiveTournament`
 * (which the organizer-facing `/tournament` commands use) specifically
 * because `DRAFT` must never be surfaced publicly.
 */
describe.skipIf(!(await isReachable()))('resolvePublicLandingTournament', () => {
  const guildIds: string[] = [];
  afterEach(async () => {
    for (const id of guildIds.splice(0)) await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  });

  async function makeGuild(): Promise<string> {
    const id = `landing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.guild.create({ data: { id } });
    guildIds.push(id);
    return id;
  }

  const tournament = (guildId: string, name: string, state: string) =>
    prisma.tournament.create({
      data: { guildId, name, defaultFormatKey: 'bo5-protect-veto', config: {}, state: state as never },
    });

  it('returns null for a guild with no tournaments at all', async () => {
    const guildId = await makeGuild();
    expect(await resolvePublicLandingTournament(prisma, guildId)).toBeNull();
  });

  it('returns null for a guild whose only tournament is DRAFT — never announced publicly', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'draft', 'DRAFT');
    expect(await resolvePublicLandingTournament(prisma, guildId)).toBeNull();
  });

  it('prefers a currently-running tournament over an older completed one', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'old', 'COMPLETE');
    const running = await tournament(guildId, 'running', 'RUNNING');
    const result = await resolvePublicLandingTournament(prisma, guildId);
    expect(result?.id).toBe(running.id);
  });

  it('falls back to the most recently created non-DRAFT tournament when nothing is running', async () => {
    const guildId = await makeGuild();
    await tournament(guildId, 'older', 'COMPLETE');
    const newer = await tournament(guildId, 'newer', 'CANCELLED');
    const result = await resolvePublicLandingTournament(prisma, guildId);
    expect(result?.id).toBe(newer.id);
  });
});
