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
