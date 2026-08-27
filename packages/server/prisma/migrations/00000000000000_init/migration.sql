-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TournamentState" AS ENUM ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED', 'RUNNING', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EntrantStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PlayStyle" AS ENUM ('SINGLE', 'DOUBLE');

-- CreateEnum
CREATE TYPE "DifficultySlot" AS ENUM ('NOVICE', 'EASY', 'MEDIUM', 'HARD', 'EXPERT');

-- CreateEnum
CREATE TYPE "BracketSide" AS ENUM ('WINNERS', 'LOSERS', 'GRAND_FINAL');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED');

-- CreateTable
CREATE TABLE "Guild" (
    "id" TEXT NOT NULL,
    "matchesChannelId" TEXT,
    "alertChannelId" TEXT,
    "resultsChannelId" TEXT,
    "generalChannelId" TEXT,
    "adminRoleId" TEXT,
    "toRoleId" TEXT,
    "refereeRoleId" TEXT,

    CONSTRAINT "Guild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultFormatKey" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "state" "TournamentState" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "discordUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarHash" TEXT,
    "lastSignInAt" TIMESTAMP(3),
    "discordAccessToken" TEXT,
    "discordRefreshToken" TEXT,
    "discordTokenExpiresAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("discordUserId")
);

-- CreateTable
CREATE TABLE "Admin" (
    "discordUserId" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("discordUserId")
);

-- CreateTable
CREATE TABLE "Entrant" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "seed" INTEGER,
    "checkedIn" BOOLEAN NOT NULL DEFAULT false,
    "status" "EntrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chart" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleTranslit" TEXT,
    "subtitle" TEXT,
    "subtitleTranslit" TEXT,
    "artist" TEXT,
    "artistTranslit" TEXT,
    "playStyle" "PlayStyle" NOT NULL,
    "difficulty" "DifficultySlot" NOT NULL,
    "meter" INTEGER NOT NULL,
    "stepartist" TEXT,
    "description" TEXT,
    "sourcePack" TEXT,
    "flags" TEXT[],

    CONSTRAINT "Chart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "bracket" "BracketSide" NOT NULL,
    "round" INTEGER NOT NULL,
    "formatKey" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "threadId" TEXT,
    "stateMsgId" TEXT,
    "alertMsgId" TEXT,
    "state" JSONB,
    "stateSeq" INTEGER NOT NULL DEFAULT 0,
    "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "winnerId" TEXT,
    "awaitingTo" BOOLEAN NOT NULL DEFAULT false,
    "currentChartId" TEXT,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchParticipant" (
    "matchId" TEXT NOT NULL,
    "entrantId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "place" INTEGER,

    CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("matchId","entrantId")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorId" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timer" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Timer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "messageId" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tournament_guildId_state_idx" ON "Tournament"("guildId", "state");

-- CreateIndex
CREATE INDEX "Entrant_tournamentId_status_checkedIn_idx" ON "Entrant"("tournamentId", "status", "checkedIn");

-- CreateIndex
CREATE UNIQUE INDEX "Entrant_tournamentId_discordUserId_key" ON "Entrant"("tournamentId", "discordUserId");

-- CreateIndex
CREATE INDEX "Chart_tournamentId_idx" ON "Chart"("tournamentId");

-- CreateIndex
CREATE INDEX "Match_tournamentId_status_idx" ON "Match"("tournamentId", "status");

-- CreateIndex
CREATE INDEX "Match_tournamentId_awaitingTo_idx" ON "Match"("tournamentId", "awaitingTo");

-- CreateIndex
CREATE UNIQUE INDEX "Match_tournamentId_bracket_round_slot_key" ON "Match"("tournamentId", "bracket", "round", "slot");

-- CreateIndex
CREATE INDEX "MatchParticipant_entrantId_idx" ON "MatchParticipant"("entrantId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchParticipant_matchId_slot_key" ON "MatchParticipant"("matchId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "MatchEvent_matchId_seq_key" ON "MatchEvent"("matchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MatchEvent_matchId_dedupeKey_key" ON "MatchEvent"("matchId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Timer_fireAt_idx" ON "Timer"("fireAt");

-- CreateIndex
CREATE UNIQUE INDEX "Timer_matchId_kind_key" ON "Timer"("matchId", "kind");

-- CreateIndex
CREATE INDEX "Alert_tournamentId_resolvedAt_idx" ON "Alert"("tournamentId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_tournamentId_dedupeKey_key" ON "Alert"("tournamentId", "dedupeKey");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entrant" ADD CONSTRAINT "Entrant_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chart" ADD CONSTRAINT "Chart_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Entrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_currentChartId_fkey" FOREIGN KEY ("currentChartId") REFERENCES "Chart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_entrantId_fkey" FOREIGN KEY ("entrantId") REFERENCES "Entrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timer" ADD CONSTRAINT "Timer_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timer" ADD CONSTRAINT "Timer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma's schema language cannot express.
-- See DESIGN.md, "Three constraints Prisma cannot express".
--
-- WARNING: neither object below appears in schema.prisma, because neither can.
-- `prisma migrate dev` diffs the schema against a shadow database that HAS
-- them, sees two objects the schema does not declare, and will generate a
-- migration dropping both. Always read generated SQL before applying it.
-- ---------------------------------------------------------------------------

-- One tournament held per guild, from the moment it is created. DRAFT
-- occupies the slot too — creating a tournament is what claims it, not
-- opening registration — so at most one can exist per guild at any state
-- short of COMPLETE or CANCELLED, either of which releases it.
CREATE UNIQUE INDEX "one_active_tournament_per_guild"
  ON "Tournament" ("guildId")
  WHERE "state" NOT IN ('COMPLETE', 'CANCELLED');

-- Seed uniqueness, DEFERRABLE. Seeding runs continuously from the first /join,
-- so reordering is routine, and a set-based renumber
--   UPDATE "Entrant" SET seed = ... FROM (SELECT row_number() ...) ...
-- transiently violates uniqueness partway through. Postgres checks unique
-- INDEXES per row within a statement, which is why this must be a CONSTRAINT:
-- deferred to commit, a whole reorder lands as one valid state.
--
-- NULLs remain distinct (the SQL default), so unseeded entrants coexist and a
-- dropped entrant's cleared seed frees that number. Do not convert this to
-- NULLS NOT DISTINCT: it would permit exactly one unseeded entrant.
ALTER TABLE "Entrant"
  ADD CONSTRAINT "entrant_seed_unique" UNIQUE ("tournamentId", "seed")
  DEFERRABLE INITIALLY DEFERRED;
