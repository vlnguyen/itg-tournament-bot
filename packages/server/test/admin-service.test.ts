import { afterEach, describe, expect, it } from 'vitest';
import { isBotAdmin, syncConfigAdmins } from '../src/services/admin-service.js';
import { isReachable, prisma } from './support.js';

describe.skipIf(!(await isReachable()))('admin-service', () => {
  const ids: string[] = [];
  afterEach(async () => {
    for (const id of ids.splice(0)) await prisma.admin.delete({ where: { discordUserId: id } }).catch(() => undefined);
  });

  function freshId(): string {
    const id = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ids.push(id);
    return id;
  }

  it('is not a bot admin before any sync', async () => {
    const id = freshId();
    expect(await isBotAdmin(prisma, id)).toBe(false);
  });

  it('syncConfigAdmins upserts every configured id, addedByUserId null', async () => {
    const id = freshId();
    await syncConfigAdmins(prisma, [id]);
    expect(await isBotAdmin(prisma, id)).toBe(true);
    const row = await prisma.admin.findUniqueOrThrow({ where: { discordUserId: id } });
    expect(row.addedByUserId).toBeNull();
  });

  it('is additive — re-running with a smaller list does not remove anyone', async () => {
    const a = freshId();
    const b = freshId();
    await syncConfigAdmins(prisma, [a, b]);
    await syncConfigAdmins(prisma, [a]); // b dropped from config, but never removed
    expect(await isBotAdmin(prisma, a)).toBe(true);
    expect(await isBotAdmin(prisma, b)).toBe(true);
  });

  it('does not clobber a row added through the web UI (non-null addedByUserId) on re-sync', async () => {
    const id = freshId();
    await prisma.admin.create({ data: { discordUserId: id, addedByUserId: 'some-promoter' } });
    await syncConfigAdmins(prisma, [id]);
    const row = await prisma.admin.findUniqueOrThrow({ where: { discordUserId: id } });
    expect(row.addedByUserId).toBe('some-promoter');
  });
});
