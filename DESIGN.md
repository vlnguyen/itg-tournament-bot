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

**Why Prisma over TypeORM or Drizzle.** Prisma's type inference and migration tooling are the strongest of the three, and the schema lives in one file rather than being spread across decorated entity classes. TypeORM has deeper Nest precedent but weaker inference and a rougher migration story; Drizzle is closer to SQL and lighter, but has less Nest-specific guidance. Raw SQL stays available for the bracket and standings queries where it is clearer.

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

**The rule that keeps this honest:** `DiscordModule` and `ApiModule` are *transports*. They parse input, check authorization, and call domain services. They contain no match rules. Every rule lives in `MatchModule` / `BracketModule`, which know nothing about Discord or HTTP — they depend on the ports below, never on a library.

This is what makes the requirement that TOs can rule "from the alert channel, from slash commands, or from the web UI" cheap: three transports, one implementation.

## Ports and Adapters

The Discord library is a **replaceable adapter behind an interface**, not a dependency the domain knows about. Domain services depend on ports; the concrete implementation is injected.

```ts
/** Everything the domain needs from a chat platform. */
interface MatchChannelPort {
  createMatchThread(input: { title: string; memberIds: string[] }): Promise<ThreadRef>;
  postMatchState(thread: ThreadRef, view: PendingActionView): Promise<void>;
  postResultSummary(thread: ThreadRef, summary: MatchSummary): Promise<void>;
  archiveThread(thread: ThreadRef): Promise<void>;
}

/** Organizer-facing alerts. */
interface AlertPort {
  raise(alert: ToAlert): Promise<void>;
}

/** Private, per-user prompts — the prisoner's dilemma. */
interface PrivatePromptPort {
  promptPrivately(userId: string, prompt: ChoicePrompt): Promise<void>;
}
```

`MatchModule` imports these interfaces and nothing else. `DiscordModule` provides implementations bound by Nest DI:

```ts
{ provide: MATCH_CHANNEL_PORT, useClass: DiscordMatchChannelAdapter }
```

**What this buys, in order of likelihood:**

- **Tests run with in-memory fakes.** No Discord connection, no mocking a large third-party client. This is the payoff that matters day to day.
- **necord vs. discord.js stops being load-bearing.** Pick either; it is an implementation detail of one adapter. Start with whichever is more pleasant and swap if it disappoints.
- A different platform, or a web-only match flow, becomes an additional adapter rather than a rewrite.

The ports are defined by **what the domain needs**, not by what Discord offers. `PrivatePromptPort` says "ask this user privately" — it does not mention ephemeral interaction replies, which is how Discord happens to satisfy it.

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

## Bracket Generation

Owned in-process. No external bracket service.

**Considered and rejected: Challonge as a bracket backend.** It would supply the pairing math, but it can only hold a thin shadow of the match model — a match in Challonge is a score like `3-2`, with no Draw, Protect/Veto sequence, per-song EX%, Decider, or tiebreak rounds. Those stay in this database regardless, leaving two systems that can drift. It would also put a third-party network call on the critical path of every committed result, defeat the real-time push requirement (no inbound push, so polling), and be unable to render the public match detail the requirements call for. The pairing math is a write-once problem; the dependency would be forever.

**Algorithm.** The conventional double-elimination construction:

- Pad to the next power of two; byes go to the highest seeds.
- Winners rounds pair by standard seed distance, keeping top seeds apart as long as possible.
- Losers rounds alternate **minor** (losers-side survivors meet) and **major** (winners-side droppers enter) rounds.
- On each major round the drop order is transformed — alternating **reverse** and **rotate** by round — so players from the same winners-bracket region are separated.
- Grand final, plus a reset bracket if the losers-side finalist wins the first set.

The transformation is computed from **bracket positions alone at generation time** and never consults results.

**Properties are asserted, not assumed.** The implementation is verified by property tests rather than trusted:

| Property | Why it matters |
| --- | --- |
| Pairing never depends on match results | Seed-neutrality — the requirement's core claim |
| Byes land on the highest seeds | Stated requirement |
| Rematches are delayed as far as the structure permits | The reason the stagger exists |
| Every entrant reaches a reachable path to the final | Catches off-by-one errors in padding |
| Bracket shape is deterministic for a given entrant count | Regenerating must not shuffle anything |

These run across every entrant count in a realistic range, not just powers of two — the bye path is where this kind of code usually breaks.

## Realtime

The public bracket updates by push.

- Browsers subscribe to a tournament channel over a websocket.
- Domain services emit an internal event after committing a `MatchEvent`; `RealtimeModule` fans it out.
- Payloads carry **public** projections only — never a pending prisoner's-dilemma selection, which must stay hidden until both players have chosen.

Single-process topology means no cross-service pub/sub. If the bot is ever split out, this becomes Postgres `LISTEN/NOTIFY` or Redis pub/sub, and is the main thing that would need rework.

**Redis is deliberately not used.** It earns its place when there is cross-process shared state, pub/sub between services, or a database under enough load to need a cache. None apply: one process, in-memory fan-out, and an authorization query against a table of hundreds of rows serving a handful of concurrent organizers. Adding it now would mean a second service in Compose and a second failure mode during a live tournament, in exchange for nothing.

**The trigger to revisit** is splitting the bot into its own service. That is the point at which cross-process pub/sub becomes necessary and Redis becomes a reasonable answer — not before.

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

### Session storage

Undecided. The analysis, so it does not have to be redone:

The permission check happens regardless — whether a user is a TO for tournament X is a query against `Organizer`, and that query is what authorizes the request. So the options are not equivalent in the way they first appear:

| | Queries/req | Instant revocation | Kill one session | Moving parts |
| --- | --- | --- | --- | --- |
| Signed cookie (user ID only) | 1 | Yes | No — secret rotation logs out everyone | None |
| Session table | 2 | Yes | Yes | Table + expiry cleanup |
| JWT with embedded roles | 0 | **No** | No — needs a denylist | Token infra |

**A session table adds a query rather than replacing one.** It is a capability choice, not a performance one: the only thing it buys is enumerating and killing individual sessions. For a system whose privileged users are a handful of TOs per guild, that is low value, and rotating the signing secret already provides a global logout.

**JWT is the one to avoid.** Requirements specify that admin promotions are logged and TO access is revocable; with roles baked into the token, a demoted TO keeps acting until it expires. Fixing that means a denylist, which is a session table with extra steps.

Leaning **signed cookie with per-request authorization**. Adopt a session table only if per-session revocation becomes a real requirement — the authorization path does not change either way, so this is cheap to defer.
- **Rendering the bracket.** A large double-elim bracket on a phone is the hardest UI problem here, and it is unsolved.
- **Whether `Match.state` is worth caching at all** before there is a measured reason.
