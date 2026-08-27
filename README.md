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

## TODO (remove this section once Phase 6 is complete)

Phase 6: the web client — public bracket, results/standings, and the
organizer console. Nothing web-related exists yet (verified this
session): no `packages/web`, no HTTP framework in `packages/server`
(`main.ts` only boots discord.js), no zod response schemas in
`packages/shared`. The projection layer this phase serves already
exists and is tested — `toPublicMatch`/`toBracketMatch` in
`packages/server/src/domain/projection.ts` — nothing there needs to
change. Stack, routes, realtime frame shape, and auth model are
already specified precisely in DESIGN.md ("The Web Client",
"Realtime", "Authentication and Authorization", "The Organizer
Console", "Client-Side Song Pack Parsing") — this list is sequencing,
not design. Follow the existing "service layer + integration tests,
then the UI, then live-verify" build order per step.

1. **NestJS bootstrap, discord.js wrapped as a module — no new features.**
   Add `@nestjs/core`/`common`/`platform-express` (or `platform-fastify`)
   to `packages/server`. Wrap the existing `registerInteractionHandlers`/
   `registerMessageListener`/`registerCommandsForAllGuilds` calls
   (currently imperative in `main.ts`) into a `DiscordModule` provider.
   New `main.ts` is `NestFactory.create(AppModule)` +
   `app.listen(port)`. This is a pure refactor — the bot must keep
   working identically. Verify live: every existing command and button
   still works exactly as before.

2. **`packages/web` scaffold.** Vite + React + TS + Mantine v7+ +
   TanStack Query + a router, one app split by route per DESIGN.md
   ("Two surfaces, one Vite app"). A `StaticModule` in Nest serves the
   built output. Verify: a placeholder route loads through the Nest
   process.

3. **Shared response schemas.** Add zod schemas to `packages/shared`
   for the wire shapes `toPublicMatch`/`toBracketMatch` already
   produce — the client's types become `z.infer` of these, per
   DESIGN.md's "no parallel DTO layer" rule. Leave
   `packages/server/src/domain/projection.ts` itself untouched (pure,
   tested, Phase 2 code); the API layer maps its output into the
   shared shape.

4. **Auth: Discord OAuth2 + session cookie.** `identify` scope only,
   signed cookie carrying just the Discord user ID, no session table.
   Extract a transport-independent tier-resolution service from
   `discord/tier.ts`'s existing logic so Nest guards and Discord
   interactions share one authorization check, per DESIGN.md,
   "Authentication and Authorization". Wire the already-stubbed
   `DISCORD_CLIENT_ID`/`SECRET`/`OAUTH_REDIRECT_URL`/`SESSION_SECRET`
   env vars.

5. **Core public REST + realtime.** `GET /api/tournaments/:id`,
   `GET /api/matches/:id` per DESIGN.md's route table. WebSocket
   gateway broadcasting `{ matchId, seq, projection }` frames off the
   existing match-event-append pipeline (hook near
   `applyAppendResult`/`persistAndCascade`). Verify: fetch each route
   manually and confirm a WS client receives frames during a live-played
   match.

6. **Public bracket UI.** The bracket component — DESIGN.md flags this
   as "the hardest UI problem in the project": semantic nested ordered
   lists, CSS Grid, responsive collapse to single-column + round
   selector, `aria-hidden` connectors, the three-tier live-region
   announcement policy. Match detail page. Landing-page redirect to
   the active/most-recent tournament. TanStack Query wired to
   `setQueryData` + drop-stale-`seq` + `refetchOnReconnect`. WCAG 2.1
   AA is a real requirement on this surface.

7. **Standings, results archive, player pages.** Reuse
   `computeTournamentStandings` directly (same source the Discord
   announcement already uses, so they can't disagree). Player pages
   keyed on `(guildId, discordUserId)`, served `X-Robots-Tag: noindex`.

8. **Song pack: public tab + organizer import flow.** Read-only
   pack tab (client-side filter over the whole loaded pack,
   `searchableText()` from `packages/shared`). Organizer import: Web
   Worker parse via the `simfile-parser` package, preview/dedupe table,
   `POST /api/tournaments/:id/charts`, full server-side re-validation
   against the same shared schema (not optional — the client fully
   controls that payload).

9. **Organizer console.** Run view (alert queue ∪ `awaitingTo` matches,
   live match list), match detail overrides
   (`POST /api/matches/:id/rulings`, gated by the same freeze predicate
   used everywhere else), seeding UI (one reorder call, drag or typed
   seed), tournament configuration
   (`POST /api/tournaments/:id/lifecycle`), server reconfiguration
   (Manage Guild gated, not tier), bot administrator's read-only
   server list, first-run wizard (a view over `Guild`/`DRAFT`
   `Tournament` rows, no separate wizard state). Best-effort
   accessibility only — no required conformance level here, unlike
   step 6.

10. **Dashboard.** Signed-in convenience only, never capability: link
    into a live match thread, standing in the running tournament, past
    events in that server.

11. **Deployment.** Single `app` container (NestJS serves API +
    websockets + the static Vite build) added to `docker-compose.yml`
    alongside the existing `postgres` service. Confirm every
    already-stubbed `.env.example` var is actually consumed.

Close out each step per this project's usual order: service-layer
logic + integration tests against real Postgres first, then the UI/
route, then live-verify by actually running the app, before moving to
the next step. This will not fit in one sitting — work through it
incrementally across sessions, committing per step.
