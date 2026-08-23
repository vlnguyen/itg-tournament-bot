# ITG Tournament Bot — Design

How the system specified in [REQUIREMENTS.md](REQUIREMENTS.md) is built. Requirements say *what*; this document says *how*, and records why each choice was made so it can be revisited deliberately.

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript, end to end |
| Backend | NestJS (single process) |
| Discord | discord.js |
| Database | PostgreSQL |
| Data access | Prisma |
| Frontend | React, built with Vite, served statically by Nest |
| Realtime | WebSockets via `@nestjs/websockets` |
| Deployment | Docker Compose on a single VPS |

**Why one language.** Song packs are parsed **client-side** and the browser sends a JSON chart list to the server. The server cannot trust that payload and must re-validate it. With TypeScript on both sides the chart schema is declared once and shared, so parser output and server validation cannot drift.

**Why a single process.** At the stated scale — tens of entrants, one active tournament per guild — separate services would buy independent scaling nobody needs while adding a message bus purely so bot events could reach browsers. In one process a Discord interaction handler calls the same service the REST API calls and pushes to the websocket gateway directly.

## Architecture

```
                    ┌──────────────────────────────┐
   Discord  ◄──────►│  DiscordModule               │
   gateway          │    commands, buttons, modals │
                    ├──────────────────────────────┤
                    │  MatchModule    ← core logic │
                    │  BracketModule               │
                    │  TournamentModule            │
                    │  SongPackModule              │
                    ├──────────────────────────────┤
   Browser  ◄──────►│  ApiModule      REST + OAuth │
                    │  RealtimeModule websockets   │
                    │  StaticModule   Vite build   │
                    └──────────────┬───────────────┘
                                   │  Prisma
                            ┌──────▼──────┐
                            │ PostgreSQL  │
                            └─────────────┘
```

**The rule that keeps this honest:** `DiscordModule` and `ApiModule` are *transports*. They parse input, check authorization, and call domain services. They contain no match rules. Every rule lives in `MatchModule` / `BracketModule`, which know nothing about Discord or HTTP.

This is what makes the requirement that TOs can rule "from the alert channel, from slash commands, or from the web UI" cheap: three transports, one implementation.

## Data Model

Sketch, not final. Prisma models, abbreviated.

```prisma
model Guild {
  id              String   @id            // Discord guild ID
  matchesChannelId String?
  toAlertChannelId String?
  tournaments     Tournament[]
}

model Tournament {
  id          String   @id @default(cuid())
  guildId     String
  name        String
  formatKey   String                      // pluggable ruleset, see below
  config      Json                        // timers, per-match allocation
  state       TournamentState             // DRAFT | REGISTRATION | CHECKIN | ...
  organizers  Organizer[]                 // the TO list
  entrants    Entrant[]
  charts      Chart[]                     // this tournament's song pack
  matches     Match[]
}

model Entrant {
  id           String  @id @default(cuid())
  tournamentId String
  discordUserId String                    // identity — never changes
  displayName  String                     // snapshot at registration
  seed         Int?
  checkedIn    Boolean @default(false)
  status       EntrantStatus              // ACTIVE | WITHDRAWN
  @@unique([tournamentId, discordUserId])
}

model Chart {
  id           String  @id @default(cuid())
  tournamentId String
  title        String                     // titleTranslit || title, resolved at import
  subtitle     String?
  artist       String?
  playStyle    PlayStyle                  // SINGLE | DOUBLE
  difficultySlot DifficultySlot           // NOVICE..EXPERT
  rating       Int
  stepartist   String?
  sourcePack   String?
  lengthSeconds Int?
  flags        String[]                   // ["noCmod"]
}

model Match {
  id           String  @id @default(cuid())
  tournamentId String
  bracket      BracketSide                // WINNERS | LOSERS | GRAND_FINAL
  round        Int
  slot         Int                        // position within the round
  playerAId    String?
  playerBId    String?
  threadId     String?                    // Discord thread
  state        Json                       // current reduced match state
  status       MatchStatus                // PENDING | IN_PROGRESS | COMPLETE
  winnerId     String?
  events       MatchEvent[]
}

model MatchEvent {
  id        String   @id @default(cuid())
  matchId   String
  seq       Int                           // monotonic per match
  type      String                        // DRAW, PROTECT, VETO, SCORE_SUBMITTED, ...
  payload   Json
  actorId   String?                       // discord user, or null for bot
  createdAt DateTime @default(now())
  @@unique([matchId, seq])
}
```

### Why an append-only event log

`MatchEvent` is the source of truth; `Match.state` is a cached reduction of it.

Three requirements push toward this, and each would otherwise need bespoke work:

- **"Full state is persisted; a restart mid-Protect/Veto resumes exactly where it left off."** Replay events, get state. Nothing to reconstruct by hand.
- **The public match view** must show every chart drawn, the full Protect/Veto sequence, per-song scores and winners, and every tiebreak round. That *is* the event log, rendered.
- **"Results freeze as they commit. Nothing rewinds."** Append-only storage makes immutability structural rather than a rule the code has to remember. A TO override is a new event, never a mutation.

`Match.state` exists so the common path — "what is this match waiting on?" — is a single column read rather than a replay.

## Match Format as a Plugin

Requirements demand additional formats be addable without rework, while only Bo5 ships. The boundary:

```ts
interface MatchFormat {
  readonly key: string;              // "bo5-protect-veto"
  readonly drawSize: number;         // 7

  /** Fold one event into state. Pure. */
  reduce(state: MatchState, event: MatchEvent): MatchState;

  /** What the match is waiting on right now. Pure. */
  pendingAction(state: MatchState): PendingAction;

  /** Set outcome, or null if undecided. Pure. */
  outcome(state: MatchState): MatchOutcome | null;
}
```

Everything specific to Bo5 — the ABBAAB sequence, the loser-picks-next preference order, the tie fall-through to protect order, the Decider, reaching 3 points, the prisoner's dilemma loop — lives behind this interface in `Bo5ProtectVetoFormat`.

**These three functions are pure.** No database, no Discord, no clock. That makes the entire ruleset unit-testable by feeding it event sequences, which matters given how many edge cases the rules carry: ties awarding nothing, the play-order fall-through when a loser has neither a Protect nor the Decider left, reshuffling on an undersized song pack.

Transports never branch on format. They ask `pendingAction()` what to render and append the resulting event.

## Drawing Charts

One shared utility implements the general rule from requirements:

```ts
function draw(pack: Chart[], count: number, eligible: (c: Chart) => boolean): Chart[]
```

Draw uniformly from eligible charts; if more are needed than remain, take what is left, reset eligibility across the whole pack, and continue. Callers supply eligibility — everything for the initial Draw, "not yet drawn in this match" for a tiebreak round.

Exhaustion is normal, not an error. A 4-chart pack yields a 7-chart Draw containing duplicates.

**Randomness is seeded per draw and the seed is stored in the event.** Draws are then reproducible for audit, and a disputed draw can be shown to have been fair.

## Realtime

The public bracket updates by push.

- Browsers subscribe to a tournament channel over a websocket.
- Domain services emit an internal event after committing a `MatchEvent`; `RealtimeModule` fans it out.
- Payloads carry **public** projections only — never a pending prisoner's-dilemma selection, which must stay hidden until both players have chosen.

Single-process topology means no cross-service pub/sub. If the bot is ever split out, this becomes Postgres `LISTEN/NOTIFY` and is the main thing that would need rework.

## Authentication and Authorization

- **Web:** Discord OAuth2. Session cookie carries the Discord user ID.
- **Discord:** interactions arrive with the invoking user ID already trusted.

Authorization is one service, transport-independent:

| Check | Source of truth |
| --- | --- |
| Is this user a TO for tournament X? | `Organizer` rows — **not** Discord roles |
| Is this user a bot administrator? | Config allowlist ∪ `Admin` table |
| May this user act in match M? | Is one of the two players, or a TO |

Config admins are re-applied additively at boot, which is the lockout recovery path.

Public bracket and match history need **no authentication** — sign-in only adds a personalized dashboard.

## Client-Side Song Pack Parsing

Simfiles never reach the server.

1. Browser reads a `.zip` or directory (File System Access API, with a `.zip` fallback).
2. A TypeScript `.sm`/`.ssc` parser extracts charts, resolving `titleTranslit || title` and friends at parse time.
3. Browser POSTs a JSON chart list.
4. **Server re-validates against the same shared schema** and persists.

The parser is shared code, but step 4 is not optional — the client fully controls that payload.

## Deployment

```yaml
services:
  app:      # NestJS: gateway + API + websockets + static build
  postgres:
```

Requirements: an always-on process (the gateway connection is persistent), public HTTPS for the OAuth callback, `DATABASE_URL`, and Discord credentials. Reverse proxy terminates TLS.

Prisma migrations run on deploy. Backups are `pg_dump` on a schedule — self-hosted Postgres means this is yours to own.

## Testing Strategy

| Layer | Approach |
| --- | --- |
| Format rules | Pure unit tests over event sequences. Highest value — this is where the rules live |
| Bracket generation | Property tests: seed-neutrality of losers routing, bye placement, reset handling |
| Draw utility | Property tests, including exhaustion and undersized packs |
| Services | Integration tests against a throwaway Postgres |
| Transports | Thin enough to cover lightly |

## Open Questions

- **discord.js directly, or `necord`?** Necord is more Nest-idiomatic (decorator-based commands, DI-friendly); raw discord.js is one less dependency and better documented. Leaning necord.
- **Bracket generation algorithm.** Requirements fix the *properties* — predetermined stagger, seed-neutral, never reacting to results. The concrete transformation per round is still to be chosen and property-tested.
- **Session storage.** Cookie-only vs a sessions table, which would let admin promotions revoke live sessions.
- **Rendering the bracket.** A large double-elim bracket on a phone is the hardest UI problem here, and it is unsolved.
- **Whether `Match.state` is worth caching at all** before there is a measured reason.
