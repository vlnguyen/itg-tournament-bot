# ITG Tournament Bot

A Discord bot that runs In The Groove tournaments — double elimination brackets, Protect/Veto song selection, and match reporting — paired with a web app for organizers and a public bracket for spectators.

## Status

Implemented and live-tested: the match rules, bracket generation, concurrency model, Discord surface, web client, and organizer console. Remaining work is tracked in DESIGN.md's build order — timers and the reconciler (step 5) are designed but not yet built, and deployment (a container for the app process) hasn't started. One design question is deliberately left open, and it is marked as such.

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

## TODO

Everything through Phase 6 (the web client — public bracket, results/
standings, and the organizer console) is built and live-tested. What
remains, per DESIGN.md's "Build Order":

1. **Timers, alerts, the reconciler** (DESIGN.md "Timers", "The
   reconciler"). `Timer` and `Alert` already exist as Prisma models,
   and escalation/dispute alerts are wired up, but nothing creates,
   sweeps, or fires a `Timer` row — the start-window and time-limit
   thresholds specified in DESIGN.md don't exist yet. Nor does the
   boot-time/per-minute reconciler that repairs drift between Discord
   and the database (missed thread provisioning, stale state
   messages, etc.). Build them together, per DESIGN.md: the sweeper
   that fires timers is the same poller that runs the reconciler's
   periodic pass.

2. **Deployment.** `docker-compose.yml` only has `postgres`. Add a
   `Dockerfile` and a single `app` container (NestJS serves API +
   websockets + the static Vite build) alongside it. Confirm every
   already-stubbed `.env.example` var is actually consumed.

One design question remains explicitly open (DESIGN.md, "Role
hierarchy is a different matter"): whether the bot can edit a channel
overwrite targeting a Discord role above its own — unverified either
way, and non-blocking since `/setup` repair already degrades to
reporting what it can't fix.

Close out each step per this project's usual order: service-layer
logic + integration tests against real Postgres first, then the UI/
route, then live-verify by actually running the app, before moving to
the next step.
