import type { PrismaClient } from '@prisma/client';

/**
 * "Is this user a bot administrator? Config allowlist ∪ Admin table." See
 * DESIGN.md, "Authentication and Authorization". Deployment-scoped, not a
 * Discord role — "Bot Administrator," never plain "Administrator" ("Two
 * things called 'administrator'").
 */
export async function isBotAdmin(prisma: PrismaClient, discordUserId: string): Promise<boolean> {
  const row = await prisma.admin.findUnique({ where: { discordUserId } });
  return row !== null;
}

/**
 * "Config admins are re-applied additively at boot. The boot pass upserts
 * every ID in ADMIN_DISCORD_IDS into Admin and removes nobody, so editing
 * the config and redeploying always restores access — the lockout
 * recovery path the requirements specify." A row added through the web UI
 * carries `addedByUserId`; one applied from the allowlist leaves it null.
 */
export async function syncConfigAdmins(prisma: PrismaClient, adminDiscordIds: readonly string[]): Promise<void> {
  for (const discordUserId of adminDiscordIds) {
    await prisma.admin.upsert({
      where: { discordUserId },
      create: { discordUserId, addedByUserId: null },
      update: {},
    });
  }
}

/** `ADMIN_DISCORD_IDS` is comma-separated, per `.env.example`; blank entries from stray commas or whitespace are dropped. */
export function parseAdminDiscordIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
