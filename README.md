# ITG Tournament Bot

A Discord bot that runs In The Groove tournaments — double elimination brackets, Protect/Veto song selection, and match reporting — paired with a web app for organizers and a public bracket for spectators.

## Status

Pre-implementation. Requirements and design are drafted; no code yet.

## Documents

- **[REQUIREMENTS.md](REQUIREMENTS.md)** — what the system does. Tournament lifecycle, match rules, the three surfaces.
- **[DESIGN.md](DESIGN.md)** — how it gets built. Stack, architecture, data model.

## Planned stack

TypeScript throughout — NestJS, discord.js, PostgreSQL with Prisma, React via Vite. Deployed as a single container alongside Postgres.
