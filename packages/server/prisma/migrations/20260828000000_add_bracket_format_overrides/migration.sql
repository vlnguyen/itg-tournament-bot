-- Per-match format overrides and the field size the current bracket was
-- generated for. See DESIGN.md, "Match Format as a Plugin".
--
-- Verified against a scratch shadow database via `prisma migrate diff`
-- rather than `prisma migrate dev` — the latter's shadow-database diff also
-- proposes dropping `entrant_seed_unique` (constraints.sql's hand-written
-- constraint, absent from schema.prisma by necessity; see that file's own
-- warning). That DROP is intentionally excluded here.
ALTER TABLE "Tournament" ADD COLUMN     "bracketEntrantCount" INTEGER,
ADD COLUMN     "formatOverrides" JSONB NOT NULL DEFAULT '{}';
