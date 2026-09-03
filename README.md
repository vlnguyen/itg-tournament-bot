# ITG Tournament Bot

A Discord bot that runs In The Groove tournaments — double elimination brackets, Protect/Veto song selection, and match reporting — paired with a web app for organizers and a public bracket for spectators.

## Status

Implemented, deployed, and live-tested: the match rules, bracket generation, concurrency model, Discord surface, web client, and organizer console, running via the Docker Compose stack in this repo (an `app` container alongside Postgres, plus Caddy for production HTTPS). One design question is deliberately left open, and it is marked as such.

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

Nothing tracked. Everything through Phase 6 (the web client — public
bracket, results/standings, and the organizer console) and deployment
(Docker Compose, the `app` container, Caddy) are built and live-tested.

Timers, alerts, and the reconciler (DESIGN.md "Timers", "The
reconciler") stay designed but unbuilt — no longer planned work, not a
gap. `Timer` and `Alert` remain as Prisma models and escalation/dispute
alerts are wired up; nothing creates, sweeps, or fires a `Timer` row.

One design question remains explicitly open (DESIGN.md, "Role
hierarchy is a different matter"): whether the bot can edit a channel
overwrite targeting a Discord role above its own — unverified either
way, and non-blocking since `/setup` repair already degrades to
reporting what it can't fix.
