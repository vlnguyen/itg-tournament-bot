# ITG Tournament Bot

A Discord bot that runs In The Groove tournaments — double elimination brackets, Protect/Veto song selection, and match reporting — paired with a web app for organizers and a public bracket for spectators.

## Status

Pre-implementation. No code yet, but the design is substantially complete: the match rules, bracket generation, concurrency model, Discord surface, web client, and organizer console are all specified with their reasoning recorded. One question is deliberately left open, and it is marked as such.

## Documents

- **[REQUIREMENTS.md](REQUIREMENTS.md)** — what the system does, and why it should behave that way for the people using it. Tournament lifecycle, match rules, roles and permissions, the three surfaces.
- **[DESIGN.md](DESIGN.md)** — how it gets built, and why each approach was chosen over the alternatives. Stack, architecture, data model, failure handling.

### How these change

Both are **living documents** until implementation starts.

They change for different reasons and at different rates. REQUIREMENTS.md changes when the desired behaviour changes; DESIGN.md changes whenever the build approach does, which is far more often. If the design is churning and the requirements are stable, that is healthy — the reverse would mean the spec is being used as a design scratchpad.

Changes also flow **both ways**. Designing something regularly surfaces an ambiguity nobody had noticed, a cheaper mechanism than the spec assumed, or an internal contradiction — and the requirement gets amended. Pre-implementation, discovering these in prose is the entire point.

Neither document carries a changelog. Git history is the record, and commit messages say what changed and why. A document that argues with its own past is harder to read than one that simply states what is true now.

The split is deliberate: **requirements state the rule, the design explains why it is that rule.** Alternatives analysis lives in DESIGN.md so the spec stays readable.

## Planned stack

TypeScript throughout. NestJS with discord.js in a single process, PostgreSQL via Prisma, React built with Vite and served statically by Nest. Mantine for UI, TanStack Query for client data, zod schemas shared between server and browser. Deployed with Docker Compose alongside Postgres.

## TODO (remove this section once the work below is complete)

Mid-implementation of the `/dq` and `/forfeit` slash commands (referee-only; last two commands in REQUIREMENTS.md's inventory table still unimplemented). Left off partway through, with the tree in a clean, typechecking, fully-passing state — nothing broken, just not finished. Remaining steps, in order:

1. **Rewire `packages/server/src/discord/interactions.ts`** to import `applyAppendResult`, `describeStale`, and `CANCELLED_MATCH_MESSAGE` from the new `packages/server/src/discord/match-event-effects.ts` (already extracted, already used by nothing yet), and delete interactions.ts's now-duplicated local copies of those three plus `renderActionLog`. The extraction exists specifically so the referee command handlers below can reuse this logic without an import cycle back through `commands/router.ts`.
2. **Extend `disqualifyFromTournament`** in `packages/server/src/services/advancement-service.ts` to return which live match (if any) it resolved — currently it silently updates the DB with no Discord-side rendering (no thread log post, no result summary, no archive). Return enough (`matchId`, the `MatchEvent` it appended, the `AppendResult`) for a command handler to call `applyAppendResult` afterward, the same pattern `cancelTournament` already uses (returning `cancelledMatchIds` for its caller to act on).
3. **Build the command layer**:
   - `discord/commands/authz.ts` needs a `requireRefereeTier` helper alongside the existing `requireOrganizerTier`.
   - `discord/log-messages.ts` needs `renderDqLog` and `renderForfeitLog`.
   - New `discord/commands/rulings.ts` implementing `/dq` (match-scope resolves the match via `loadMatchByThreadId` on the invoking thread; tournament-scope resolves the tournament via `findActiveTournament` and calls `disqualifyFromTournament`) and `/forfeit` (resolves the *opponent* of the named player as `winnerId` — the command's `player` option is the one forfeiting, but `FORFEIT_APPLIED`'s payload wants the winner).
   - Wire both into `discord/commands/router.ts`.
4. **Tests**: update the two existing `disqualifyFromTournament` tests in `packages/server/test/advancement-service.test.ts` for its new return shape; add coverage for `/dq` and `/forfeit`.
5. **Close out**: typecheck, run the full suite, update DESIGN.md/REQUIREMENTS.md, restart the bot and verify live, then commit.
