-- Backfills migration history for two schema changes that were applied to
-- the dev database ad hoc (outside the normal migration flow) before the
-- init migration stopped being regenerated in place. No-op in dev — this
-- file exists so `prisma migrate deploy` applies the same DDL anywhere this
-- hasn't already run (e.g. a fresh environment).

-- AlterEnum
ALTER TYPE "public"."MatchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN IF NOT EXISTS "discordAccessToken" TEXT,
ADD COLUMN IF NOT EXISTS "discordRefreshToken" TEXT,
ADD COLUMN IF NOT EXISTS "discordTokenExpiresAt" TIMESTAMP(3);
