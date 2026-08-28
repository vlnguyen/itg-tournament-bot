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
| UI components | Mantine — the only styling system |
| Client data | TanStack Query |
| API contract | REST controllers, zod schemas shared with the client |
| Realtime | WebSockets via `@nestjs/websockets` |
| Deployment | Docker Compose on a single VPS |

**Why one language.** Song packs are parsed **client-side** and the browser sends a JSON chart list to the server. The server cannot trust that payload and must re-validate it. With TypeScript on both sides the chart schema is declared once and shared, so parser output and server validation cannot drift.

**Why Prisma over TypeORM or Drizzle.** Prisma's type inference and migration tooling are the strongest of the three, and the schema lives in one file rather than being spread across decorated entity classes. TypeORM has deeper Nest precedent but weaker inference and a rougher migration story; Drizzle is closer to SQL and lighter, but has less Nest-specific guidance. Raw SQL stays available for the bracket and standings queries where it is clearer, and for the two constraints Prisma's schema language cannot express (see Data Model).

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
                    │  SchedulerModule  timers     │
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

This is what makes the requirement that referees can rule "from the alert channel, from slash commands, or from the web UI" cheap: three transports, one implementation.

## Ports and Adapters

The Discord library is a **replaceable adapter behind an interface**, not a dependency the domain knows about. Domain services depend on ports; the concrete implementation is injected.

```ts
/** Everything the domain needs from a chat platform. */
interface MatchChannelPort {
  createMatchThread(input: { title: string; playerIds: string[] }): Promise<ThreadRef>;
  postMatchState(thread: ThreadRef, view: PendingActionView): Promise<void>;
  postResultSummary(thread: ThreadRef, summary: MatchSummary): Promise<void>;
  archiveThread(thread: ThreadRef): Promise<void>;
  /** One public line per finished match, outside any thread. */
  publishResult(summary: PublicMatchSummary): Promise<void>;
}

/** "Tell these players their match is ready" — the adapter decides how. */
interface PlayerNotificationPort {
  matchReady(playerIds: string[], thread: ThreadRef): Promise<void>;
}

/** Organizer-facing alerts. */
interface AlertPort {
  raise(alert: ToAlert): Promise<AlertRef>;
  resolve(ref: AlertRef, outcome: AlertOutcome): Promise<void>;
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

The ports are defined by **what the domain needs**, not by what Discord offers. `PrivatePromptPort` says "ask this user privately" — it does not mention ephemeral interaction replies, which is how Discord happens to satisfy it. `PlayerNotificationPort.matchReady` says "tell these players"; that it lands as both a thread mention and a direct message is the adapter's business, and swapping one out changes no domain code.

### Two more ports, for determinism

`ClockPort` (`now(): Date`) and `RandomPort` (`seed(): string`, `nextInt(seed, n, i): number`) exist for the same reason as the others: the domain must be testable without ambient state. Draws are reproducible because the seed comes from a port and is written into the event; timer thresholds are testable because "now" is injected. Both have a real implementation and a fixed-value fake.

## Data Model

Prisma models, abbreviated. Sketch, but the constraints called out below are load-bearing.

```prisma
model Guild {
  id               String   @id            // Discord guild ID
  matchesChannelId String?                 // hosts threads; no bot messages in its body
  alertChannelId   String?
  resultsChannelId String?
  generalChannelId String?                 // optional forward target — where competitors discuss
  adminRoleId      String?            // tier 3 — may reconfigure the bot here
  toRoleId         String?            // tier 2 — may run tournaments
  refereeRoleId    String?            // tier 1 — may rule on matches
  tournaments      Tournament[]
}

model Tournament {
  id          String   @id @default(cuid())
  guildId     String
  name        String
  defaultFormatKey String                 // stamped onto every match generated
  config      Json                        // TournamentConfig, below
  state       TournamentState             // DRAFT | REGISTRATION_OPEN | ...
  entrants    Entrant[]
  charts      Chart[]                     // this tournament's song pack
  matches     Match[]
}

model User {
  discordUserId String    @id          // identity, never changes
  displayName   String?                // CURRENT name — never for historical rendering
  avatarHash    String?
  lastSignInAt  DateTime?
}

// No Organizer table — authority is Discord role membership,
// resolved to a tier. See Server Onboarding: Three tiers of privilege.

model Admin {
  discordUserId String   @id          // deployment-scoped; not a Discord role
  addedByUserId String?               // null when applied from the config allowlist
  createdAt     DateTime @default(now())
}

model Entrant {
  id            String  @id @default(cuid())
  tournamentId  String
  discordUserId String                    // identity — never changes
  displayName   String?                   // snapshot taken at tournament start
  seed          Int?
  checkedIn     Boolean @default(false)
  status        EntrantStatus             // ACTIVE | WITHDRAWN
  @@unique([tournamentId, discordUserId])
  @@unique([tournamentId, seed])
}

model Chart {
  id             String  @id @default(cuid())
  tournamentId   String
  title            String                 // both forms stored; display resolves
  titleTranslit    String?
  subtitle         String?
  subtitleTranslit String?
  artist           String?
  artistTranslit   String?
  playStyle        PlayStyle              // SINGLE | DOUBLE
  difficulty       DifficultySlot         // the named slot, NOVICE..EXPERT
  meter            Int                    // the numeric block rating
  stepartist       String?                // #CREDIT
  description      String?                // #DESCRIPTION — free-text chart label
  sourcePack       String?
  flags            String[]               // ["noCmod"]
}

model Match {
  id           String  @id @default(cuid())
  tournamentId String
  bracket      BracketSide               // WINNERS | LOSERS | GRAND_FINAL
  round        Int
  formatKey    String                    // the ruleset this match ran under
  slot         Int                       // position within the round
  threadId     String?                   // Discord thread
  state        Json                      // cached reduction, see below
  stateSeq     Int     @default(0)       // event seq the cache reflects
  alertMsgId   String?                   // open escalation message, for edit-in-place
  // --- projection columns: derived on write, for many-match queries ---
  status       MatchStatus               // PENDING | IN_PROGRESS | COMPLETE
  winnerId     String?                   // cache of the participant with place 1
  awaitingTo   Boolean @default(false)   // pendingAction is AWAITING_TO
  currentChartId String?                 // chart being played, if any
  events       MatchEvent[]
  @@unique([tournamentId, bracket, round, slot])
}

model MatchParticipant {
  matchId   String
  entrantId String
  slot      Int                          // position within the match
  points    Int     @default(0)
  place     Int?                         // 1 is the winner; ties share a place
  @@id([matchId, entrantId])
  @@unique([matchId, slot])
}

model MatchEvent {
  id         String   @id @default(cuid())
  matchId    String
  seq        Int                          // monotonic per match
  type       String                       // see event catalog
  payload    Json
  actorId    String?                      // discord user, or null for bot
  dedupeKey  String?                      // originating interaction ID
  createdAt  DateTime @default(now())
  @@unique([matchId, seq])
  @@unique([matchId, dedupeKey])
}

model Timer {
  id           String   @id @default(cuid())
  tournamentId String
  matchId      String?
  kind         String                     // MATCH_START_WINDOW | MATCH_TIME_LIMIT
  fireAt       DateTime
  firedAt      DateTime?
  cancelledAt  DateTime?
  @@index([fireAt])
  @@unique([matchId, kind])
}

model Alert {
  id             String    @id @default(cuid())
  tournamentId   String
  matchId        String?
  kind           String                    // MATCH_START_OVERDUE | MATCH_TIME_EXCEEDED | PLAYER_LEFT_GUILD
  payload        Json
  dedupeKey      String                    // e.g. "start-overdue:<matchId>"
  messageId      String?                   // posted alert, for edit-in-place
  resolvedBy     String?
  resolvedAt     DateTime?
  createdAt      DateTime  @default(now())
  @@unique([tournamentId, dedupeKey])
}

model AuditLog {
  id          String   @id @default(cuid())
  actorUserId String
  action      String                      // ADMIN_PROMOTED | TO_ADDED | SONG_RULED | ...
  targetType  String
  targetId    String
  payload     Json
  createdAt   DateTime @default(now())
}
```

**`Tournament.config`** is a single JSON column rather than three nullable integers, so a new format can add its own knobs without a migration:

```ts
interface TournamentConfig {
  matchStartWindowMinutes: number;   // default 10 — alert threshold, not enforcement
  matchTimeLimitMinutes: number;     // default 25
  perMatchAllocationMinutes: number; // default 25 — feeds the duration estimate
}
```

All three are alert thresholds or estimates. Nothing inside a match format is configurable, per the requirements — set length, draw size and action order are properties of the format.

### Three constraints Prisma cannot express

All three need raw SQL in a migration, and all three are worth the awkwardness because they enforce a requirement at the only level that cannot be bypassed by a bug in a service.

**One tournament held per guild.** A partial unique index:

```sql
CREATE UNIQUE INDEX one_active_tournament_per_guild
  ON "Tournament" ("guildId")
  WHERE "state" NOT IN ('COMPLETE', 'CANCELLED');
```

A tournament occupies the slot **from the moment it is created** — `DRAFT` included — per REQUIREMENTS.md's "held from the moment it is created... no separate 'preparing the next one' state that doesn't count." `/tournament create` is the action that claims the slot, and only `COMPLETE` or `CANCELLED` release it. `createTournament` checks this first for a friendly `TournamentSlotOccupiedError`, naming what's already held; the index is what actually guarantees it under a race between two concurrent creates. A TO who wants to change a held draft's name before opening registration uses `/tournament rename` rather than discarding and recreating it — see "Tournament Lifecycle".

**Sparse seed uniqueness.** `@@unique([tournamentId, seed])` allows multiple nulls, so unseeded entrants coexist while seeds are still being assigned and assigned seeds cannot collide. This is the SQL standard's nulls-are-distinct rule rather than a Postgres quirk — but **PostgreSQL 15 added `UNIQUE NULLS NOT DISTINCT`**, which inverts it. The design depends on the default; a migration that opts into the inversion would permit exactly one unseeded entrant per tournament, so the dependency is written down rather than assumed.

**Deferred seed uniqueness.** Seeding runs continuously from the first `/join`, so reordering is a routine live operation rather than one-time entry — and **swapping two seeds transiently violates uniqueness** partway through. A unique *index*, which is what Prisma's `@@unique` produces, is checked per statement and cannot be deferred. A unique *constraint* can:

```sql
ALTER TABLE "Entrant" DROP CONSTRAINT IF EXISTS "Entrant_tournamentId_seed_key";
ALTER TABLE "Entrant"
  ADD CONSTRAINT entrant_seed_unique UNIQUE ("tournamentId", "seed")
  DEFERRABLE INITIALLY DEFERRED;
```

Checked at commit rather than per row, a whole reorder lands as one valid state. The alternative — writing a temporary sentinel seed, then the real one — is two writes per row and a window where the table is briefly nonsense.

Two distinct cases need this, and only one is obvious:

- **Arbitrary reordering**, where a target seed may be higher than its source, so an intermediate state genuinely collides.
- **Compacting after check-in**, which looks safe because every target is lower than its source — and is, if you update row by row in ascending order. But the natural implementation is one set-based `UPDATE … FROM (SELECT row_number() …)`, and Postgres checks unique indexes **per row within a statement**, not at statement end. This is why `UPDATE t SET n = n + 1` fails on a unique column despite a valid final state. Deferral is what lets the renumber be a single statement.

### Why an append-only event log

`MatchEvent` is the source of truth; `Match.state` is a cached reduction of it.

Three requirements push toward this, and each would otherwise need bespoke work:

- **"Full state is persisted; a restart mid-Protect/Veto resumes exactly where it left off."** Replay events, get state. Nothing to reconstruct by hand.
- **The public match view** must show every chart drawn, the full Protect/Veto sequence, per-song scores and winners, and every tiebreak round. That *is* the event log, rendered.
- **"Results freeze as they commit. Nothing rewinds."** Append-only storage makes immutability structural rather than a rule the code has to remember. A referee override is a new event, never a mutation.

`Match.state` exists so the common path — "what is this match waiting on?" — is a single column read rather than a replay. `stateSeq` records which event the cache reflects, so a cache that ever falls behind is detectable rather than silently wrong: on read, if `stateSeq` does not equal the match's highest event seq, replay and repair.

## Match State and the Event Catalog

The reducer's state, trimmed to its shape:

```ts
interface MatchState {
  seq: number;                       // last event folded in
  a?: EntrantId;                     // whoever took the first Protect
  b?: EntrantId;
  draw: ChartSnapshot[];             // 7, in draw order — see Snapshotting a chart
  protects: { drawIndex: number; by: EntrantId }[]; // in protect order
  vetoes:   { drawIndex: number; by: EntrantId }[];
  decider?: ChartId;
  songs: SongRecord[];               // one per song started, in play order
  points: Record<EntrantId, number>;
  tiebreaks: TiebreakRound[];
  escalation?: { songIndex: number; reason: EscalationReason };
  confirmations: EntrantId[];        // set-result sign-off
  pending: PendingAction;
}

interface SongRecord {
  chart: ChartSnapshot;
  drawIndex?: number;                // which Draw position this consumed
  tiebreakRound?: number;
  source: 'FIRST_PROTECT' | 'LOSER_PROTECT' | 'PROTECT_ORDER' | 'FORCED' | 'DECIDER' | 'TIEBREAK';
  ex: Partial<Record<EntrantId, number>>;
  photoSeen: Record<EntrantId, boolean>;
  selections: Partial<Record<EntrantId, EntrantId | 'TIE'>>;
  result?: { winner: EntrantId | 'TIE' | 'VOID'; by: 'AGREEMENT' | 'TO_RULING' };
}
```

The event catalog. `actor` is the Discord user ID on player and referee events, null on bot events.

| Event | Actor | Payload |
| --- | --- | --- |
| `MATCH_CREATED` | bot | entrant IDs, seeds, bracket position |
| `SEED_CHOICE_MADE` | higher seed | `{ order: 'FIRST' \| 'SECOND' }` — fixes who is A |
| `DRAW_MADE` | bot | `{ seed, charts: ChartSnapshot[7] }` — metadata as it was, not just IDs |
| `CHART_PROTECTED` | player | `{ chart }` |
| `CHART_VETOED` | player | `{ chart }` |
| `PROTECT_VETO_RESET` | Referee | `{ reason }` — legal only before song 1 |
| `SONG_STARTED` | bot | `{ songIndex, chart, source }` |
| `SCORE_SUBMITTED` | player | `{ songIndex, ex }` |
| `PHOTO_OBSERVED` | bot | `{ songIndex, playerId, messageId }` |
| `SONG_WINNER_SELECTED` | player | `{ songIndex, choice: EntrantId \| 'TIE' }` |
| `SONG_ESCALATED` | bot or player | `{ songIndex, reason }` — actor is the reporter, if any |
| `SONG_RULED` | Referee | `{ songIndex, result, note }` |
| `TIEBREAK_DRAWN` | bot | `{ round, seed, charts: ChartSnapshot[3] }` |
| `TIEBREAK_CHOICE` | player | `{ round, chart }` — **hidden until both land** |
| `SET_RESULT_CONFIRMED` | player | `{}` |
| `FORFEIT_APPLIED` | Referee | `{ winnerId }` |
| `DQ_APPLIED` | Referee | `{ playerId, scope: 'MATCH' \| 'TOURNAMENT' }` |
| `WALKOVER` | bot | `{ winnerId }` — opponent withdrew or received a bye |

### No commit events

**There is no `SONG_COMMITTED` event, and no `SET_COMMITTED`.** A song is committed once the log holds agreeing `SONG_WINNER_SELECTED` events from both players, or a single `SONG_RULED`. The set is decided when `outcome()` says it is. Neither fact gets written down; both are read out of what is already there.

The freeze boundary from the requirements therefore has exactly one expression — `songs[i].result !== undefined` — and the reducer, the override check, and the public projection all read that same predicate. A commit event would be a second record of a fact the selections already carry, and a second record is something that can disagree with the first.

Two conditions make this sound, and both are settled elsewhere in this document.

**The commit boundary needs a total order.** Song 3 is live. Both players select the same winner at the moment a referee, in the alert channel, clicks *award the song to B*. Whether that ruling is legal turns on whether it lands before or after the second selection — and with nothing written at the instant of commit, it is not obvious what arbitrates. The per-match row lock does: every append serializes through `SELECT … FOR UPDATE` on the `Match` row (see Concurrency), so the three actions take a definite order and each is validated against the state its predecessors left behind. The ruling either finds song 3 open and appends, or finds it settled and is refused. The lock is load-bearing for the event model, not only for write safety; weakening either means revisiting the other.

**Replay needs to be stable.** A derived commit is a function of the events *and* the code that folds them, so an edit to the reducer can change what an archived tournament decided — precisely what a written commit event would have nailed down. Format versioning and golden replay, below, is the answer: `formatKey` pins each match to the rules that ran it, and a CI corpus of archived logs fails the build if any committed outcome shifts.

**`Match.status`, `Match.winnerId`, and `Match.state` are the materialized commit** — cache, on the same footing as `state` and covered by the same `stateSeq` check. No authorization decision reads them.

**Why the bot does not derive the song winner from the two EX% values.** It could — it has both numbers — and it does display the comparison. But the requirement is that both players select the winner and agree, and disagreement is an escalation with real evidentiary weight: the photos exist precisely because a self-reported EX% can be wrong. Deriving the result would collapse the disagreement path that the whole photo requirement is built around. The comparison is shown as a suggestion; the commit comes from agreement.

## Match Format as a Plugin

Requirements demand additional formats be addable without rework, while only Bo5 ships. The boundary:

```ts
interface MatchFormat {
  readonly key: string;              // "bo5-protect-veto"
  readonly drawSize: number;         // 7
  /** Charts a pack should hold for this format to behave well. */
  readonly recommendedPackSize: number;  // 10 — a Draw plus one clean tiebreak round

  /** Fold one event into state. Pure. */
  reduce(state: MatchState, event: MatchEvent): MatchState;

  /** What the match is waiting on right now. Pure. */
  pendingAction(state: MatchState): PendingAction;

  /** Set outcome, or null if undecided. Pure. */
  outcome(state: MatchState): MatchOutcome | null;

  /** What just became true, for the caller to act on. Pure. */
  effects(before: MatchState, after: MatchState): DomainEffect[];
}
```

Everything specific to Bo5 — the ABBAAB sequence, the loser-goes-next preference order, the tie fall-through to protect order, the Decider, reaching 3 points, the prisoner's dilemma loop — lives behind this interface in `Bo5ProtectVetoFormat`.

### The format belongs to the match

`Match.formatKey` is the ruleset a match ran under. `Tournament.defaultFormatKey` is what gets stamped onto every match at generation, and **for now that is the whole story** — every match in a tournament shares one format.

Storing it per match anyway is not speculation, it is the same rule the rest of this design follows: **capture what applied at the moment it mattered, rather than inferring it later from a parent that can change.** Chart metadata is snapshotted into draw events for that reason; the display name is snapshotted at start for that reason. A match's rules are the same kind of fact, and reading them off the tournament would mean a format change mid-event silently rewrites how a finished match is interpreted.

It also makes a known future feature a config change rather than a migration. Events where machines are scarce commonly run Bo3 until Winners Finals, Losers Finals and the Grand Finals, which are Bo5. Under this shape that is a rule for choosing which key to stamp during generation — the reducer, the event log, replay, and every projection already work per match. Under a tournament-level key it would be a schema change to a table holding live tournaments.

**What will need revisiting when exceptions ship** is the duration estimate. It currently multiplies bracket depth by one `perMatchAllocationMinutes`, which stops being right the moment a Bo3 round and a Bo5 round take visibly different times. That is a config shape question — an allocation per format — and it is noted here so it is found by reading rather than by a schedule that runs long.

`effects` exists because of the derived commit. Something has to notice that song 3 just became final so the thread gets a summary and the match time-limit timer is cancelled, and with no commit event to subscribe to, the alternative is the service comparing `before` and `after` itself — which means a service reasoning about format-specific state shape, exactly the coupling the plugin boundary exists to prevent. Returning a *description* of what to do keeps it pure and testable: `SongCommitted`, `TiebreakResolved`, `EscalationOpened`, `SetDecided`. The service interprets them after the transaction commits. Effects are match-scoped only — bracket advancement is the service's reaction to `outcome() !== null`, because a format has no business knowing brackets exist.

**All four functions are pure.** No database, no Discord, no clock. That makes the entire ruleset unit-testable by feeding it event sequences, which matters given how many edge cases the rules carry: ties awarding nothing, the play-order fall-through when a loser has neither a Protect nor the Decider left, reshuffling on an undersized song pack.

The types the interface names:

```ts
type EscalationReason = 'WINNER_DISAGREEMENT' | 'SETTINGS_VIOLATION';

interface MatchOutcome {
  /** Every participant, ordered by finish. Ties share a place, competition-style. */
  placements: { entrantId: EntrantId; place: number; points: number }[];
  by: 'AGREEMENT' | 'RULING' | 'FORFEIT' | 'DQ' | 'WALKOVER';
}

/** Match-scoped only. Bracket advancement is the service's reaction to outcome(). */
type DomainEffect =
  | { kind: 'SONG_COMMITTED'; songIndex: number }
  | { kind: 'TIEBREAK_RESOLVED'; round: number }
  | { kind: 'ESCALATION_OPENED'; songIndex: number; reason: EscalationReason }
  | { kind: 'ESCALATION_CLOSED'; songIndex: number }
  | { kind: 'SET_DECIDED' };
```

`PendingAction` is a discriminated union naming the actor and the legal choices:

```ts
type PendingAction =
  | { kind: 'SEED_CHOICE'; actor: EntrantId }
  | { kind: 'PROTECT' | 'VETO'; actor: EntrantId; choices: number[] }
  | { kind: 'SUBMIT_SCORE'; actors: EntrantId[]; songIndex: number }
  | { kind: 'SELECT_WINNER'; actors: EntrantId[]; songIndex: number }
  | { kind: 'TIEBREAK_PICK'; actors: EntrantId[]; round: number; choices: number[] }
  | { kind: 'AWAITING_BOT'; directive: BotDirective }
  | { kind: 'CONFIRM_RESULT'; actors: EntrantId[] }
  | { kind: 'AWAITING_TO'; reason: EscalationReason }
  | { kind: 'DONE' };
```

#### Draws are addressed by position, not by chart

Protect and Veto carry a **`drawIndex`**, and `PendingAction.choices` is a list of positions. Chart ids cannot work: an undersized pack legitimately produces a Draw containing the same chart twice, so "protect chart X" is ambiguous at any pack size below the draw size. Tiebreak choices are indices for the same reason.

#### `AWAITING_BOT` — work the bot owes the match

Play order is fully determined, so the bot starts each song itself rather than prompting anyone. But starting one needs the song pack and a fresh seed, which a pure reducer cannot see. So `pendingAction` can return `AWAITING_BOT` carrying a **`BotDirective`**:

```ts
type BotDirective =
  | { do: 'DRAW'; count: number }
  | { do: 'DRAW_TIEBREAK'; round: number; count: number }
  | { do: 'START_SONG'; source: SongSource; drawIndex?: number;
      tiebreakRound?: number; chartIndex?: number };
```

The format decides *what* is due; the service supplies what the format cannot know, appends the resulting event, and folds it. The loop repeats until a person is on the clock. This is what keeps `reduce` pure while letting the format drive the parts of the set that need no human.

Transports never branch on format. They ask `pendingAction()` what to render, validate the incoming action against it, and append the resulting event. **Validation is exactly this comparison** — an action is legal iff its actor and value appear in the current `PendingAction`. There is no second copy of the rules in the transport layer to fall out of step.

**There is no pending action between songs.** Play order is fully determined (see below), so the format appends the next `SONG_STARTED` itself rather than prompting anyone. This does not cross the automation boundary: the bot is not picking on a player's behalf, because there is never a pick to make. `PendingAction` has no next-song variant for the same reason — a future format that genuinely offers a choice adds one.

### Play order is fully determined

Requirements originally said the loser takes "their own remaining Protect" — singular — while a loser may hold **two**. Song 1 is always A's first protect, so if **B** loses it, B holds both B1 and B2: the first branch of roughly half of all matches was underdetermined.

**Resolved, and the requirement now says so: a player's own protects are consumed in the order they were protected.** The loser plays their earliest unplayed protect. No choice is offered.

The consequence is larger than the rule: **every next-song decision in the set is now deterministic.** Each of the four cases resolves to exactly one chart —

| Situation | Next song |
| --- | --- |
| Start of set | A's first protect |
| Loser holds own protects | Their earliest unplayed one |
| Loser holds none, Decider unplayed | The Decider |
| Loser holds none, Decider played | The one chart left (see below) |
| Song tied — no loser | Next unplayed in protect order, falling through to the Decider |

— so the bot advances the set on its own from the moment Protect/Veto ends until a tiebreak is needed or the set is decided. The only interactive steps left in a match are the seed choice, the six ABBAAB actions, score submission, winner selection, tiebreak picks, and the final confirmation.

**The tie clause is still needed.** "Loser's earliest own protect" and "next unplayed in protect order" look the same but are not: if A loses song 1 (A1), the loser rule gives A2, while protect order would give B1. Both functions have to exist.

**Case 4 has exactly one candidate — provably, and not obviously.** The requirements assert that with no own protect left and the Decider played, what remains is "necessarily the opponent's Protect, so the choice is forced." Two opponent protects remaining would break that. It cannot happen, but only because of the point structure: for two to remain, three songs must have been played and they must be the Decider plus both of the picker's own protects. Song 1 is always A's first protect, so the picker is A and the order is A1, A2, D — which requires A to have lost songs 1 and 2 (a tie routes to protect order, yielding B1, and a B loss deploys B's own protect). A is then 0–2, and losing the Decider ends the set 0–3. There is no fourth song.

The conclusion holds; the reasoning is fragile enough that a future format tweak could quietly invalidate it. So it is asserted, not assumed — see the play-order property test.

### The rules do not guarantee termination

A tie awards nothing, and the tiebreak repeats until a player reaches three. A match in which every song ties therefore generates tiebreak rounds **forever**.

This is correct rather than a defect — the bot never decides an outcome on its own, and a stalled match is resolved by a referee — but it is worth stating because it is easy to assume otherwise. A property test asserting the rules always terminate **failed**, and the property was wrong, not the rules. Two tests now pin the behaviour: one drives twenty-five consecutive tied songs and asserts no outcome exists, one has a referee end it.

Anything later that reasons about match completion must not assume the set terminates on its own.

### The freeze boundary is enforced by the reducer

*Results freeze as they commit; nothing rewinds* is validated at the transport, where an action is legal only if it matches the current `pendingAction`. The reducer enforces it a second time:

- A **ruling on a committed song** is ignored, whether the song was agreed by the players or already ruled.
- An **escalation raised against a committed song** is ignored. Accepting one would strand the match in `AWAITING_TO` with no legal exit, since the only way out is a ruling on a song that no longer needs one — a stale *report a settings problem* button would wedge a match permanently.
- A **second terminal event** — forfeit, DQ, walkover — cannot overturn the first.

Two layers rather than one, because a corrupted log must not replay into a corrupted result. Transport validation protects the live path; reducer refusal protects replay, which is the thing the append-only design exists to guarantee.

**Disagreement escalation is derived, not stored.** Two players selecting different winners is already a complete record of the dispute, so a `SONG_ESCALATED` event for that case would be a second record able to disagree with the first. The event survives only for a **settings violation**, which nothing else in the state implies.

### Format versioning and golden replay

Because commits are derived, an archived match's outcome is a function of its events **and** the reducer that reads them. A reducer edit could silently change what a finished tournament decided.

**`formatKey` lives on the match, not the tournament.** Replay reads the match's own key, so a genuine rules change ships as a new key — `bo5-protect-veto-v2` — and leaves finished matches reading the rules they actually ran under, even within a tournament that spans the change.

That only helps if rules changes are *distinguishable* from bug fixes, which they are not by inspection. So the boundary is enforced mechanically: **a corpus of archived event logs is replayed in CI, and every committed song result, set result, and final placement must come out identical.** A change that breaks the corpus is a rules change by definition and needs a new key; a change that does not is a bug fix and may ship in place. The corpus starts with hand-written sequences covering the edge cases and grows with every real tournament.

This is what makes derived commits safe to keep, and it is cheaper than writing them: one test, and it catches reducer drift that explicit commit events would have concealed rather than prevented.

## Drawing Charts

One shared utility implements the general rule from requirements:

```ts
function draw(pack: Chart[], count: number, eligible: (c: Chart) => boolean, seed: string): Chart[]
```

Draw uniformly from eligible charts; if more are needed than remain, take what is left, reset eligibility across the whole pack, and continue. Callers supply eligibility — everything for the initial Draw, "not yet drawn in this match, in any status" for a tiebreak round.

Exhaustion is normal, not an error. A 4-chart pack yields a 7-chart Draw containing duplicates.

**Draws are independent, and that is the point of the pack never shrinking.** Playing a chart does not consume it: every match's Draw samples the whole pack, so the same chart can appear in several matches in the same round, and what one pair drew has no bearing on what another pair draws. The requirement that charts are never removed once played is this property stated as a rule about the pack — it is not about a TO deleting rows.

The only memory anywhere in drawing is **within a single match**: a tiebreak round excludes charts already drawn in that match, in any status. Nothing carries across matches, and nothing carries across tournaments. The `eligible` predicate is the whole of it, which is why independence is cheap to guarantee — there is no accumulated state that could leak between draws.

**Randomness is seeded per draw and the seed is stored in the event.** Draws are then reproducible for audit, and a disputed draw can be shown to have been fair. The seed is generated once, written into `DRAW_MADE`, and the chart list is stored alongside it rather than recomputed — the stored list is authoritative, and the seed exists so the list can be *checked*, not so it can be regenerated by a future version of the shuffle whose behaviour may have drifted.

## Concurrency, Ordering, and Idempotency

Two players act in the same thread at the same time. Both submit scores, both select winners, both make tiebreak picks. A single Node process does not serialize this for free — every handler is async and interleaves at every `await`.

**Every state-changing action runs inside one transaction that takes a row lock on `Match` first.**

```
BEGIN
  SELECT ... FROM "Match" WHERE id = $1 FOR UPDATE      -- serializes the match
  replay-or-read state
  validate action against pendingAction(state)
  INSERT MatchEvent (seq = state.seq + 1)
  UPDATE Match SET state = reduce(...), stateSeq = ...
COMMIT
then, outside the transaction: post to Discord, fan out to websockets
```

The lock is per match, so concurrent matches never contend — and at this scale contention within a match is two people, not two hundred. `@@unique([matchId, seq])` stays as a backstop: if a future change makes an append escape the lock, the write fails loudly instead of producing a forked event log.

**Side effects happen after commit, never inside the transaction.** A Discord API call inside a transaction holds the row lock for a network round trip and, worse, can succeed while the transaction rolls back — posting a message about a state that does not exist. The cost of the ordering is that the commit can succeed and the post can fail, which is the correct direction to fail: the state is right and the thread is stale, recoverable by re-posting from state.

**Double-clicks are deduplicated by interaction ID.** Discord gives every interaction a snowflake; it becomes `MatchEvent.dedupeKey`, unique per match. A duplicate append fails on the unique index and is treated as success — the user already did this, and the outcome they wanted is already recorded.

**A stale button is rejected cleanly.** Buttons persist in the thread after the state moves on. Validation against `pendingAction` catches them, and the transport answers ephemerally with what actually happened ("song 2 already has both winners") rather than an error. This matters more than it sounds: after a restart, every button in every thread is from a previous process, and they all still work because nothing about them was held in memory.

## Bracket Generation

Owned in-process. No external bracket service.

**Considered and rejected: Challonge as a bracket backend.** It would supply the pairing math, but it can only hold a thin shadow of the match model — a match in Challonge is a score like `3-2`, with no Draw, Protect/Veto sequence, per-song EX%, Decider, or tiebreak rounds. Those stay in this database regardless, leaving two systems that can drift. It would also put a third-party network call on the critical path of every committed result, defeat the real-time push requirement (no inbound push, so polling), and be unable to render the public match detail the requirements call for. The pairing math is a write-once problem; the dependency would be forever.

### The winners bracket, exactly

Pad the field to `2^k`. Seed positions follow the standard recursive construction:

```
order(1)  = [1]
order(2n) = order(n).flatMap(s => [s, 2n + 1 - s])
```

which gives `[1, 2]`, then `[1, 4, 2, 3]`, then `[1, 8, 4, 5, 2, 7, 3, 6]`. Round 1 pairs consecutive entries, so an eight-slot bracket plays 1–8, 4–5, 2–7, 3–6. Top seeds are kept apart for as long as the structure allows, and this falls out of the construction rather than being arranged.

**Byes need no special case.** Seeds above the real entrant count are byes, and because seed 1 is paired with `2^k`, seed 2 with `2^k - 1`, and so on, the byes land on the highest seeds automatically — the stated requirement, satisfied by the seeding order itself.

### The losers bracket

`2(k − 1)` rounds. Round 1 takes every winners round 1 loser, preserving winners-match order. After that, **even-numbered rounds are major** — winners-side droppers enter — and **odd-numbered rounds are minor**, where losers-side survivors meet.

#### Why a stagger is needed at all

Without one, an immediate rematch is not bad luck — it is structural. Take eight slots, winners order `[1, 8, 4, 5, 2, 7, 3, 6]`, higher seed winning throughout:

| | |
| --- | --- |
| WR1 | `M0 = 1v8`, `M1 = 4v5`, `M2 = 2v7`, `M3 = 3v6` — so 8, 5, 7, 6 drop |
| LR1 | `LM0 = 8v5`, `LM1 = 7v6` — say 5 and 6 survive |
| WR2 | `M4 = 1v4`, `M5 = 2v3` — say 4 and 3 drop |

Map the droppers straight down and `M4`'s loser meets `LM0`'s survivor: **4 versus 5, who played each other in WR1**. The reason is general rather than particular to this example — a winners round 2 dropper and the losers round 1 survivors from the same half of the bracket are *exactly* the players they just beat.

Reverse the mapping and `M4`'s loser meets `LM1`'s survivor instead: 4 versus 6, who have never played.

#### The transformations

Each major round maps `m` droppers, indexed by winners-match position, onto `m` receiving slots:

- **Reverse** — dropper `i` goes to slot `m − 1 − i`. Sends droppers to the far end of the losers bracket, maximally distant from the region that produced them.
- **Rotate by half** — dropper `i` goes to slot `(i + m/2) mod m`.

**Alternating them matters because both are involutions.** `reverse ∘ reverse` is the identity, and so is `rotate ∘ rotate`; applying the same transformation at consecutive major rounds hands back the separation the previous one bought, and players drift toward the region they came from. Alternating composes to something non-trivial — over four regions `reverse ∘ rotate` gives `[1, 0, 3, 2]`.

That argument is reasoning rather than provenance, and it is weaker than it looks at small sizes: with `m = 2` the two transformations are the same permutation, and with `m = 1` both are the identity. It only bites in the earlier major rounds of a large bracket.

**Which applies to which round is a convention, not a derivation**, and conventions differ between bracket software. Implement with *reverse* at the first major round and alternate thereafter — then let the property tests arbitrate. If an entrant count produces a rematch earlier than the structure requires, the delay property fails and the parity for that round flips. This is the one place in the design where the tests are the specification and the algorithm is a starting point; the alternative is asserting a convention here that could simply be wrong.

**If matching an existing platform matters** — and it may, since players arrive with expectations from brackets elsewhere — Challonge is the practical oracle. Its API exposes each match's `player1_prereq_match_id` and `player2_prereq_match_id` along with whether the feed is a winner or a loser, so the whole match graph comes out as data rather than something to read off a rendered image. Generate at 8, 16, 11 and 13 participants — the non-powers of two matter most, since that is where byes interact with the stagger — set grand finals to the two-match form to match this design, and commit the result as a fixture the generator must reproduce.

Using Challonge this way contradicts nothing above: it was rejected as a **runtime dependency**, and that rejection explicitly conceded it would supply the pairing math. An offline fixture costs nothing on the critical path.

Whatever is chosen, the transformation is computed from **bracket positions alone at generation time** and never consults results — which is the property that actually matters, and the one the requirements care about.

The grand final follows, plus a reset bracket if the losers-side finalist wins the first set.

**The whole bracket is materialized up front**, byes included. A match whose occupants are not yet known simply has no `MatchParticipant` rows — advancement inserts one as each becomes known, rather than creating matches on the fly. That keeps the public bracket renderable in full from the moment the tournament starts, makes the duration estimate a walk over real rows, and means an unfilled slot is an absent row rather than a null column.

**Properties are asserted, not assumed.** The implementation is verified by property tests rather than trusted:

| Property | Why it matters |
| --- | --- |
| Pairing never depends on match results | Seed-neutrality — the requirement's core claim |
| Byes land on the highest seeds | Stated requirement |
| Rematches are delayed as far as the structure permits | The reason the stagger exists |
| Every entrant reaches a reachable path to the final | Catches off-by-one errors in padding |
| Bracket shape is deterministic for a given entrant count | Regenerating must not shuffle anything |

These run across every entrant count in a realistic range, not just powers of two — the bye path is where this kind of code usually breaks.

## Advancement, Walkovers, and Standings

Bracket generation is one problem; moving players through it is another, and it is where the requirements' edge cases live.

**Advancement runs in the same transaction as the event that decides the set.** With no `SET_COMMITTED` event to react to, the transaction that appends the second `SET_RESULT_CONFIRMED` sees `outcome()` turn non-null and advances before it commits — so "set decided ⟹ bracket advanced" is an invariant of the database rather than of a background job. The row count is small even for the withdrawal cascade below; a 64-entrant bracket holds 126 matches in total. Thread provisioning stays outside the transaction, because it is a network call — `applyAppendResult` (`match-event-effects.ts`) runs it immediately afterward, on every match decision, not only at `/tournament start`; there is no boot-time reconciler yet, so a crash between the commit and that call is not currently repaired on restart.

**Advancement is a bracket-side operation triggered by a committed set result**, and it routes by **placement** rather than by winner and loser. Place 1 is inserted into the successor winners-side match; place 2 into the successor losers-side match, or eliminated if they were already in the losers bracket. When a downstream match has all its participants, it becomes ready and the thread is provisioned.

Double elimination is therefore the two-participant case of a general rule — *place 1 advances, place 2 drops* — rather than a shape the routing is written around. See Seating more than two players.

**A bye is a walkover, not a match.** Round 1 matches with one null occupant are settled by a `WALKOVER` event at generation time — the requirement's stated exemption from the automation boundary. No thread is created.

**A bye's effect on the losers bracket is not confined to round 1.** A winners-round-1 bye produces no loser, so whichever losers-bracket slot would have received it structurally never can — `liveSourceCount` (`bracket.ts`) computes, per match, how many of its two sources can *ever* resolve to a real occupant (0, 1, or 2), propagating through `WINNER_OF`/`LOSER_OF` edges exactly as `simulateBracket` already did for property testing; only the live-engine side was missing. A slot with one live source resolves the moment its one possible occupant is seated — `maybeStartMatch` (`engine.ts`) calls `startWithSeats` rather than waiting on a second seat that can't arrive — unconditionally, even if that occupant is withdrawn: there is no second real participant to walk over *to* here, so they still advance, and get walked over transparently at the next genuine two-participant match downstream, the same as a withdrawn entrant reaching any other match. A slot with zero live sources is never touched at all — nothing ever fills it, which is sufficient on its own, since nothing downstream ever depends on a fill that was never coming.

At entrant counts where byes run deep relative to the round-1 field (5 and 9 are the sharpest examples in the property-test range), several losers-round-1 slots can land at zero live sources simultaneously — normal, not a bug: those pairings structurally never had anyone to hold them.

**`maybeStartMatch` is idempotent on `Match.status`, not just on `threadId`.** A single cascade's `touched` set can legitimately name the same match twice — once because it received a fill directly, again because a *different* fill's own recursive walkover chain reached and started that same match first, several one-live-source slots deep. Re-checking `status !== 'PENDING'` before starting anything is what stops the second visit from appending a second `MATCH_CREATED` — this collision was latent before the point above made same-transaction, multi-hop walkover chains routine rather than rare.

**Tournament-scope disqualification cascades.** `DQ_APPLIED` with scope `TOURNAMENT` sets the entrant to `WITHDRAWN` and then, in the same transaction, walks both brackets: every not-yet-started match where they occupy a slot resolves as a `WALKOVER` to the opponent, and each of those resolutions advances, which may itself fill another match containing them. The walk repeats until no match containing a withdrawn entrant remains unresolved. This is the single referee action the requirement asks for.

The one case needing care: if their *current, in-progress* match is mid-set, that match resolves as a forfeit — an ordinary loss — and then the cascade covers the losers-side path they would have dropped into.

**Grand final reset is a distinct match row, not a rerun.** It exists in the generated bracket from the start with `bracket = GRAND_FINAL, round = 2`, and is skipped by advancement when the winners-side finalist takes the first set. Because it is a separate row it gets a fresh event log, hence a fresh Draw and a full ABBAAB — which is exactly what the requirement asks for. Seed advantage reads from `Entrant.seed`, not from anything about the first set, so the winners-bracket finalist keeps the first-or-second Protect choice in both.

**Standings are derived, never stored.** Placement follows elimination depth: the grand final decides 1st and 2nd, the last losers round decides 3rd, and players eliminated in the same losers round share a placement (4th, then 5–6, 7–8, and so on). A query over `Match` grouped by the round in which each entrant took their second loss produces this directly; withdrawn entrants place by where their withdrawal landed them. Deriving rather than storing means a late referee ruling that changes a match also changes the standings, with nothing to invalidate.

### Seating more than two players

**Every match that ships is 1v1**, and the bracket generator, advancement routing and the Bo5 format all assume exactly two. What changed is only how participation is *stored*: a match holds participants, not a player A and a player B. `MatchParticipant` carries the entrant, a `slot` from the bracket structure, running `points`, and a `place` once the match resolves; `MatchOutcome` is an ordered list of placements. Nothing in the match model, the event log, or the format interface counts to two.

That was not free generality — it removed a real defect. Points were previously `pointsA`/`pointsB` on `Match`, the only place in the schema identifying a player by position rather than by ID, and nothing stated whether that `A` meant the bracket slot or the format role a player takes at `SEED_CHOICE_MADE`. Those two disagree in about half of matches. The join table removes the ambiguity by removing the concept.

**What it does not buy is a format seating more than two.** A six-player gauntlet — everyone plays the same six songs, a point per opponent beaten or tied on each — is not a double-elimination match. It is a pool, and pools need tournament topology this design does not have:

- **Phases.** A tournament is currently one bracket. Pools feeding a bracket means a phase model, phase transitions, and a lifecycle that spans them.
- **Advancement routing beyond two.** "Top 2 of 6 advance" is a property of the phase, not of the match format, and there is nowhere to express it.
- **Bracket generation.** The winners construction pairs seeds; seating pools of *n* from a seeded field is a different algorithm.
- **The duration estimate.** Bracket depth times one per-match allocation already breaks once rounds differ in length, and pools break it further.

#### What blocks pools, and why deferring is safe

Four things stand between here and a pool phase:

| Blocker | What it is |
| --- | --- |
| Match addressing | `@@unique([tournamentId, bracket, round, slot])`, where `bracket` is `WINNERS \| LOSERS \| GRAND_FINAL`. A pool match has no bracket side |
| No phase concept | A tournament is one bracket, generated at start. Pools feeding a bracket means generating the bracket *after* pools resolve, seeded from their results |
| Advancement routing | Placement-based, but hardcoded to one winners successor and one losers successor |
| Standings | Derived from elimination depth; placement within a pool is a record within a group |

**Every one of them is additive.** A `Phase` model, a nullable `Match.phaseId`, and a `POOL` value on the enum are add-table, add-column, add-enum-value, with a backfill that assigns existing matches to one implicit bracket phase. Standings are derived, so changing them is code with no migration at all.

That is the whole argument for deferring. Compare it with the change that was **not** additive: participation moved from `playerAId`/`playerBId` to `MatchParticipant`, which altered how a row identifies its players and cannot be backfilled without interpreting existing data. That one had to happen before any tournament history existed, and it has. What remains can wait for a format that is actually specified rather than described in a sentence.

**Two different things get called pools, and they cost differently.** A *round-robin* pool — every pair in a group playing a 1v1 — needs the phase model and gains nothing from the participation work. A *gauntlet* pool — six players in one match at once — needs both, and the participation half is done.

## Duration Estimate

The requirement is a walk, not a formula: count the rounds that must happen **sequentially**, multiply by the per-match allocation, and add one round for a possible grand final reset.

Implemented as a **longest path through the match dependency DAG** — each match depends on the matches feeding its two slots, and the estimate is the depth of the deepest chain. Because every match in a round can run simultaneously (remote tournaments, no shared hardware), depth is the schedule.

For the standard shape this equals `2⌈log₂ n⌉ + 1` rounds including both grand final sets, which makes a clean test oracle: the DAG walk and the closed form must agree for every entrant count. If they ever diverge, the bracket generator produced a shape it should not have.

## Server Onboarding

### Bootstrap: the one place Discord permissions gate anything

A freshly-invited server has no configured tier roles, no tournament, and therefore no application-level authority. Something has to establish the first one.

**`/setup` is gated on Discord's own Manage Guild permission, full stop — there is no bound "Server Administrator" role to fall back to or from.** Whoever added the bot runs it first and names the two tier roles; Manage Guild is not a bootstrap-only fallback that a configured role later supersedes — it is the permanent, only gate, every time. "There is always one implied administrator through the server owner": whoever can manage the server in Discord's own terms already has everything `/setup` needs to grant, so tracking a separate bot-side administrator role would just be a second name for the same fact.

**It is re-runnable, which makes it the per-server recovery path.** If a tier role is deleted, emptied, or misconfigured, anyone with Manage Guild can run `/setup` again and re-point the bot. That mirrors the config allowlist at the deployment level, giving two independent recovery routes at the right scopes — neither depending on the other, and neither requiring the operator to be a member of a server they are rescuing.

**Bot administrators stay view-only.** Requirements define their capability as seeing across servers, and with self-service bootstrap and self-service recovery they never need to reach into a server's referee pool. The role keeps exactly the scope the requirements give it.

### Two tiers of privilege, plus Manage Guild outside the ladder

Authority is Discord role membership, resolved to one of two cumulative tiers. `/setup` points the bot at a role for each, stored on `Guild`. Reconfiguring the server itself (`/setup`) is a separate concern entirely, gated on Discord's own Manage Guild permission rather than a third bound role — see Bootstrap, above, and "Two things called administrator" below.

**The capability list lives in REQUIREMENTS.md**, under *What each role may do*, and is not restated here. A second copy is a second thing to keep in step, and the one that drifts is always the copy — the same reasoning that removed commit events from the match log.

What belongs here is the mechanism:

**Tiers are cumulative and totally ordered**, so a check is `tierOf(member) >= required` rather than a set intersection. `tierOf` returns the highest tier whose role the member holds, and `required` is a constant on the action — one comparison, no per-capability bookkeeping, and adding an action means naming its tier rather than editing a matrix.

**The dividing line is refereeing versus running an event:** a referee unblocks matches but cannot create, start, or close a tournament. That falls out cleanly in implementation — everything reachable from the alert channel is Referee tier, everything in the lifecycle state machine is Tournament Organizer tier, and `/setup` sits outside the ladder altogether, gated on Manage Guild instead of either.

**Tournament-scope disqualification sits with referees, deliberately** — the one placement in that list worth arguing about. It is the most consequential thing at the tier, withdrawing an entrant and cascading walkovers through both brackets. It belongs there because it is conflict resolution rather than lifecycle: the tournament-scope option exists precisely so a player who has left for good is handled in one action instead of being disqualified again in the losers bracket, and making a referee escalate for it reintroduces the friction the option was added to remove. It is audit-logged like every other ruling.

**`/commands` surfaces this ladder rather than documenting it separately.** It is `discord/commands/help.ts`, itself open to anyone, and reads its list straight off `commandDefinitions` (`definitions.ts`) so a description can never drift from what Discord actually shows in the picker — only *which group a command belongs to* is a small hand-kept map, checked by a test that cross-references it against `commandDefinitions` so an added command or subcommand with no group assigned fails loudly rather than silently vanishing from the list. `/tournament` and `/roster` are split subcommand by subcommand, since `status` and `list` are carved out ahead of their command's own organizer-tier check exactly as `/commands` itself is; every other command shares one gate for all its subcommands and gets one line.

#### Two things called "administrator"

`Tier.SERVER_ADMINISTRATOR` still exists in the tier mechanism's code as a value, but `/setup` never binds a role to it — "there is always one implied administrator through the server owner," via Manage Guild, so there is nothing left for a third bound role to add. Requirements separately define a **Bot Administrator** that is deployment-scoped — able to see every server the bot is in — granted by the config allowlist and the `Admin` table, not by any Discord role, and unrelated to server reconfiguration entirely.

Nothing should be labelled plain "Administrator" in code or UI — say **Bot Administrator** for the deployment role, and describe server reconfiguration as "Manage Guild," never as an administrator tier.

#### Servers may collapse the tiers

Nothing requires two distinct roles. A server can point both slots at the same role and get exactly the flatter model it wants: one `@Staff` role in both slots reproduces the original single-tier design.

This is an endorsed configuration, not a degenerate one. Plenty of servers want the same people involved at every level of running an event, and the tiers exist to let a server that needs the separation express it — not to impose hierarchy on one that does not. The capability model is fixed; how a server maps onto it is theirs.

#### Why roles rather than an application-held list

The alternative — an explicit list of organizers maintained inside the application, per tournament — was the original specification, and it is the safer design in the abstract. It was replaced knowingly. What roles buy:

- **Thread access stops being a mechanism.** `Manage Threads` on the tier roles grants visibility of every private thread in the matches channel. Threads no longer add organizers as members, there is no backfill when someone is granted mid-tournament, and no thread membership to reconcile after a restart. An entire subsystem deleted rather than shrunk.
- **Discord does the management** — its member picker, its permissions UI, its audit log. No grant command, no web UI for a list, nothing to keep in step with the server's own idea of who is staff.
- **A real distinction between refereeing and running an event**, which a single organizer list could not express. Trusted volunteers can unblock matches without being able to cancel the tournament.

What it costs, all accepted:

- **Anyone with Manage Roles can self-grant**, at any tier. An application-held list could not be reached that way, and this is the one genuine regression. Mitigations below.
- **Scope is server-wide, not per-tournament.** With one active tournament per server the practical difference is small, and a server cannot field different referee crews for concurrent events it cannot hold anyway.
- **"Who could rule on this tournament?" is no longer answerable.** Role membership is mutable and unversioned, in a system that otherwise treats history as immutable.

#### Mitigating what was given up

- **Role changes are mirrored into `AuditLog`.** The bot already holds the `GuildMembers` intent, so `GUILD_MEMBER_UPDATE` reports every grant and revocation of a tier role. Writing those to the audit log restores an app-side, timestamped record — a self-grant is visible after the fact even though it cannot be prevented.
- **Rulings record their actor regardless.** Every action is a `MatchEvent` with an `actorId` plus an `AuditLog` row, so while "who *could* have ruled" is lost, "who *did*" is preserved exactly — which is the question a dispute actually asks.
- **Tournament start warns on conflicts of interest.** The bot knows the entrant list and can read each tier role's members. Anyone in both is named in a non-blocking warning, the same pattern as the song-pack-size warning. This targets the regression directly: a competitor able to rule on their own match.

#### Resolving the check

Tier is read from the gateway's member cache, kept current by `GUILD_MEMBER_UPDATE`, so an authorization check is a local lookup rather than a query or an API call. A cache miss falls back to a REST member fetch. The web UI shares the process and therefore the cache, so the check is identical on both transports — authorization stays transport-independent exactly as before, against a different source of truth.

### Refereeing is a pool activity

**Refereeing is a pool activity, and there are normally several.** Everyone at Referee tier or above holds identical powers to audit a match and rule on it — the tiers above add tournament and server management, never a better ruling. Configuration being one person's job is a division of labour at the tiers above, not a hierarchy within refereeing.

Three parts of the design read differently once the role is understood as a pool rather than a person:

- **The alert channel is the work queue; the role's thread access is for auditing.** A referee is not expected to watch sixteen match threads. They watch one channel, and an alert points them at the thread that needs them. This is why alerts resolve by editing in place — with several people on one queue, an alert still showing buttons has to mean nobody has taken it.
- **Concurrent rulings are the normal case, not an edge case.** Two referees reaching for the same escalation is what a pool does under load. The match row lock orders them and the second gets "already resolved by @X" — see Organizer Alerts and Escalation.
- **A referee may never sign in to the web UI at all.** Ruling from alert buttons and slash commands is a complete workflow, which is why sign-in is tracked as information rather than enforced as a gate.

### What `/setup` does

Requirements are explicit that it does not provision channels — it asks the organizer to create them, then points the bot at them. **Both channels and roles have since grown an optional create-it-for-me path** (see "Provisioning the channels" and "Provisioning the roles" below) — point-at-existing remains the always-available fallback for both, since selection is never filtered or rejected regardless of which path was used to get the thing being pointed at.

1. Takes the matches channel, the organizer alert channel, and a role for each of the two tiers. The same role may be given for both.
2. **Accepts every selection.** No picker is filtered and no choice is rejected for lacking a permission.
3. Writes the `Guild` row, then reports a diagnostic of everything still missing.

**Selection is never the place to enforce permissions.** A server administrator choosing a role does not necessarily know its permissions, and refusing the input means they cannot even record the decision until Discord is already correct — which is backwards, because the diagnostic is what tells them what to correct. So `/setup` saves the configuration and reports; **tournament start is the blocking gate**, which is where requirements put it and where a stale configuration actually causes harm.

The same principle extends to channel selection, which your point did not name but would be inconsistent to treat differently: pick any channel, get told precisely what it lacks.

#### The diagnostic

Requirements ask that the wizard "names exactly which are missing." Doing that usefully means resolving Discord's permission chain rather than reporting a flat list, because **the fix differs depending on where a permission was lost**:

- The role lacks the permission at server level → edit the role.
- The role has it, but a channel overwrite denies it → edit the channel's permissions for that role.
- `@everyone` is denied it in the channel and the role has no explicit allow → add an allow overwrite.

A report that says "missing Manage Threads" sends someone to the wrong screen half the time. One that says "the Referee role has Manage Threads, but #matches denies it for that role" does not. The check resolves base permissions against `@everyone`, role, and member overwrites in order, and names the layer that lost it.

What it reports, per target:

| Target | Needs | Why |
| --- | --- | --- |
| Bot, in the matches channel | View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Embed Links, Read Message History | Running matches at all |
| Bot, in the organizer alert channel | View Channel, Send Messages, Embed Links, Read Message History | Raising and editing alerts |
| Bot, in the results channel | View Channel, Send Messages, Embed Links | Posting the result feed |
| Bot, in the general channel, if set | View Channel, Send Messages, Embed Links | Forwarding results |
| Each tier role, in the matches channel | View Channel, Manage Threads | Seeing private match threads. Tier capability is ours; thread visibility is Discord's, and it does not inherit — a Tournament Organizer without `Manage Threads` can rule on a match they cannot read |
| Referee tier or above | At least one member, counting across both roles | Tiers are cumulative — a Tournament Organizer can rule too — so a tournament started with nobody at Referee tier or above has no way to resolve a dispute |

The last is a warning rather than a gap, since a server may legitimately configure roles before populating them.

**Both the Referee and Tournament Organizer roles must be bound.** Neither is optional the way an empty pool is a warning: with no Tournament Organizer role, not one `/tournament` lifecycle command is reachable by anyone, and with no Referee role a disagreement has nobody to escalate to. `/setup status` and every `/setup channels`/`roles` reply reports either as missing outright until `/setup roles` binds it. Manage Guild has no equivalent requirement here — it isn't a bound role at all, and whoever holds it in Discord can always run `/setup` regardless.

**The diagnostic always lists the current bindings**, success or not — which channel and role is pointed at what, or "not configured" — so a clean report is legible on its own rather than only useful when something is wrong.

**Re-checking is one click.** The diagnostic carries a *Re-check* button, so the loop is fix-in-Discord → click → see what remains, without retyping the selections. The same report is available any time from `/setup status` and in the web wizard, which renders it as a live checklist rather than a one-shot message.

### Granting access

**Tier access is granted in Discord, by assigning the relevant role.** There is no bot command and no web UI for it.

**Bot administrator promotion picks from signed-in users.** It is deployment-scoped, so there is no guild member list to pick from — the person being promoted may be in a different server entirely. Choosing from `User` rows is the only mechanism that does not degrade to typing an ID.

**Sign-in is information, never a gate.** A referee can rule entirely from Discord — alert buttons and slash commands are equal surfaces by requirement — so a referee who never opens the web UI is fully functional.

**OAuth requests `identify guilds`.** Which servers a user may *act* in — rule on a match, run a tournament, reconfigure a server the bot is already in — is still resolved from role membership in the gateway cache, exactly as before; `guilds` is not a second notion of that. It exists for one narrower question the gateway cache cannot answer at all: the homepage's "servers you manage" list, which by requirement includes a server the user administers even if the bot has never been added to it. There is no way to see that from the bot's own guild cache, only from Discord's own account-scoped guild list. The `guilds` scope's access/refresh token pair is persisted on `User` (`discordAccessToken`/`discordRefreshToken`/`discordTokenExpiresAt`) — the one deliberate exception to the session cookie carrying nothing but the Discord user id (see "Sessions are a signed cookie..." further down): the token itself lives on `User`, never in the cookie, and only `DiscordGuildsService` ever reads it, refreshing it on demand each time the homepage asks. Anyone who signed in before this scope existed simply sees an empty list until they sign in again — a stale answer for one page, not a wrong one, and never a forced re-auth.

**The `User` table is a cache for current UI, never for history.** Requirements fix the display name as a snapshot taken at registration and stored per tournament, so past brackets show the name someone competed under. `User.displayName` serves organizer screens; rendering a bracket or match history from it would silently break that guarantee, and is the single most likely way to do so by accident.

### Permission drift during an event

Permissions are reported at `/setup` without blocking, enforced at tournament start where a missing one blocks the start, and checked **once more before each round's thread burst** — the highest-risk moment and the cheapest to guard, since one effective-permissions computation covers a burst of sixteen thread creations.

Everywhere else the adapter fails loud rather than pre-checking: a permission error is raised as an alert naming the missing permission and the action it blocked, and the operation retries once the permission returns. Polling for drift would mean recomputing two channels' permissions forever to catch a rare event, and would still miss the gap between the last poll and the next use.

### The first-run wizard

Requirements call for a guided wizard walking a new server through configuration, building a song pack, and creating its first tournament.

**It is a view over real records, not its own state machine.** Server configuration is the `Guild` row; the first tournament is a `Tournament` in `DRAFT`, which the lifecycle already defines. A half-finished setup is therefore just a draft, resumable by construction — closing the tab loses nothing, and there is no wizard-progress table to keep in step with the records it describes. It does claim the server's tournament slot the moment it exists, same as any other draft — nothing else can be created alongside it until it is renamed into shape, cancelled, or carried through to completion.

## Registration and Check-in

### The commands

All three are usable from any channel and answer **ephemerally**, so a hundred people joining produces no channel traffic at all.

| Situation | `/join` | `/checkin` | `/leave` |
| --- | --- | --- | --- |
| No tournament accepting entrants | Rejected | Rejected | Rejected |
| Window closed for that action | Rejected, naming the current phase | Rejected | — |
| Already in that state | Confirms, does not error | Confirms | — |
| Not on the roster | — | Rejected: never registered | Rejected |
| Tournament running | Rejected | Rejected | Rejected — see a referee |

"Already in that state" confirming rather than erroring is deliberate. A player who is not sure whether their `/join` landed will run it again, and an error is a worse answer than "you are in, seed 12."

**`/tournament status` is the read-only fourth.** Unlike every other `/tournament` subcommand it carries no tier gate at all — dispatched in `discord/commands/tournament.ts` ahead of the `requireOrganizerTier` check, the same way `/roster list` sits ahead of its own. It names the tournament and its phase using the same `PHASE_LABEL` strings a rejected `/join` or `/checkin` already shows, so the wording never disagrees with what those commands themselves say. It then adds whichever of `/join`/`/leave` or `/checkin`/`/leave` is actually actionable in that phase — `/leave` pairs with both, since it works "any time before it starts" rather than only during one window (see "Leaving") — and calls out `CHECKIN_CLOSED` on its own, since nothing is actionable there but it is the one phase that means the bracket is coming imminently. No entrant counts or bracket detail: that level of dashboard belongs to the organizer console's run view, not a command anyone can run from any channel.

**`DRAFT` reports as no tournament at all**, identically to the guild holding none — the one place `/tournament status` disagrees with `findActiveTournament`'s own notion of "active." A draft is a TO still setting up: `/join` doesn't work yet, nothing about it is public, and naming it here would announce a tournament to the server before its organizer chose to open it.

**`joinTournament` (`roster-service.ts`) draws the same line.** A `WINDOW_CLOSED` reply ordinarily names the phase — "registration is closed," "the tournament is running" — so a player knows what changed. `DRAFT` is deliberately excluded from that: `joinTournament` returns `NO_TOURNAMENT` instead of `WINDOW_CLOSED { phase: 'DRAFT' }`, so `/join` before a TO has opened registration reads identically to `/join` in an empty server, for the same announce-before-ready reason `/tournament status` avoids it. `/checkin` and `/leave` don't need the same treatment — `/checkin`'s only reachable `WINDOW_CLOSED` phases start at `REGISTRATION_OPEN`, downstream of the tournament already being public, and `/leave` names no phase at all.

### Who is on the roster

Two fields could have carried attendance, and only one does.

**`Entrant.checkedIn` is the single source of truth.** `EntrantStatus` is `ACTIVE | WITHDRAWN` — whether someone was *removed* from the tournament, and nothing else. There is no `NOT_CHECKED_IN` status.

The roster that plays is one predicate, valid at any point after check-in closes:

```sql
status = 'ACTIVE' AND "checkedIn"
```

An earlier draft stored both, flipping un-checked-in entrants to a `NOT_CHECKED_IN` status when the window closed. That is a second record of a fact `checkedIn` already carries, and **a second record is something that can disagree with the first** — the same objection that removed commit events from the match log. Nothing enforced the agreement, so a write path touching one field and forgetting the other would have produced an entrant who was simultaneously dropped and not dropped, with the answer depending on which field the reader consulted.

Deriving it removes the failure rather than testing for it. Two smaller consequences follow:

- **Closing check-in changes no statuses, and no seeds either.** It is a pure state flip — the drop is already recorded by the `checkedIn` the player did or did not set, and stays provisional (reorderable, reversible) until the tournament actually starts.
- **Re-checking someone in after the window is one field flip.** The organizer path that had to set `checkedIn` true *and* revert the status now just sets `checkedIn`. Fewer moving parts on the recovery path, which is where consistency bugs are least welcome.

**What `status` still distinguishes is withdrawal**, which `checkedIn` cannot express: a player who confirmed attendance and later left is `checkedIn = true, status = WITHDRAWN`, and both facts survive.

### Leaving

`/leave` works from the moment registration opens until the tournament starts, and its consequences depend on when it lands.

Either way, the mechanics are the same: the entrant is marked `WITHDRAWN` and their seed cleared — freeing that number immediately, since `entrant_seed_unique` is unconditional, not scoped to `ACTIVE`. Seed gaps left behind do not matter: they are closed exactly once, at tournament start (see Seeding), not on every withdrawal.

**After check-in closes**, a withdrawal additionally **raises an organizer alert** — a TO about to start deserves to know the field just changed, even though nothing about seeding itself is settled yet. Before that, it is routine and silent.

That difference is the cost of allowing `/leave` throughout, and it is worth paying explicitly rather than pretending the two cases are the same.

**A player may re-join only while registration is open.** After that, `/join` is closed to everyone including someone who left, so a change of heart during check-in needs an organizer.

### Acting on a player's behalf

**A Tournament Organizer can do anything a player can do for themselves**, to any entrant, until the tournament starts — add, check in, un-check-in, remove. Both from the console roster and from `/roster`, since organizers work from whichever surface is in front of them.

It is a **superset of the player's own window**, which is the point. `/join` closes when registration closes; a TO can still add someone who missed it, right up until the bracket is generated. Requirements only forbid adding entrants once the tournament has *started*.

**Tier is Tournament Organizer, not Referee.** Roster composition is tournament management rather than unblocking a match, and it sits with the tier that opens and closes the windows in the first place.

**On-behalf actions are indistinguishable in the data, and now in their public effect too.** Checking a player in as an organizer writes exactly what `/checkin` writes, and posts the exact same general-channel hype line `entrantCheckedIn` posts for a self-service check-in; `/roster add` does the same against `entrantJoined`. Removing them writes exactly what `/leave` writes — which, like `/leave` itself, posts nothing public, so there is no asymmetry to close there. The one thing that still differs, and the only thing that should, is provenance: an `AuditLog` row records who actually did it.

That is worth stating as a rule because the alternative is tempting and wrong. A separate "checked in by an organizer" flag, or a distinct status, would fork every downstream query — normalization, standings, the roster view — on a distinction that matters only for provenance. Provenance is what the audit log is for.

**Its useful consequence is the one case with no self-service equivalent.** A player cannot check themselves in after check-in closes, so what should an organizer doing it produce? The rule answers it: **the state that would have existed had the player checked in during the window.** `checkedIn` true, status back to `ACTIVE`, landing at the back of the seed order exactly like a fresh `/join` — which is exactly the late-addition path, arrived at without needing a special "un-drop" operation. It is the recovery path when check-in is closed a minute early.

**Late additions and re-check-ins raise no alert**, unlike a player's own late `/leave`: the organizer already knows what they just did, and an alert reporting it is noise. That asymmetry is the whole reason the withdrawal alert exists — it reports a change the organizers did *not* make.

**`/roster list` is the one subcommand with no tier gate** — read-only, so anyone can see who is on the roster, seeded entrants first in seed order then unseeded ones in join order. It reads `Entrant.displayName` when the tournament has a snapshot (`RUNNING` or later) and falls back to a live member fetch before that, same as every other pre-start display of a name.

### Snapshotting the display name

`Entrant.displayName` is **null until the tournament starts**. Every surface before that — the roster, the seeding interface — reads the current name from the gateway member cache, which is exactly what the `User` table is for.

At start, the bot resolves each remaining entrant's name as Discord shows it — **server nickname, else global display name, else username** — and writes it into `Entrant`. From that moment it never changes, and every bracket, match record and history page renders from it.

If a member cannot be fetched at start, the last known name from `User` is used. That case means they have left the server, which the departure alert already handles; a missing name should not be the thing that blocks a tournament from starting.

### Calling check-in

Opening check-in posts an **announcement in the general channel with no mentions**, and **direct messages every registered player**.

This is the second and last use of direct messages, on the same rationale as match-ready: a window has opened that the player cannot otherwise discover, and missing it costs them the tournament. It is not a nudge about a pending action — the bot never sends a second one, and never chases anyone who has not checked in.

**The check-in DM carries a deep link to the general channel, when one is configured.** `/checkin` is a guild-scoped command — useless from inside the DM it just arrived in — so the DM's job is not just to tell the player a window opened but to get them back into the server to act on it. Same reasoning `matchReady`'s DM already applies to its own thread link, pointed instead at the general channel, since there is no single "the" channel to send someone to otherwise. Omitted when no general channel is set, same as every other use of that optional target.

**The gap this leaves is real and is handled by a human.** With no mentions in the channel and a DM that may fail, a player who has DMs closed and is not watching the server will miss the window. So the roster view marks each entrant with two things: **checked in**, and **DM undeliverable**. An organizer can see at a glance who was never reached and chase them directly. That is the correct division — the bot does not nudge, and a person who wants to is given the information to.

**Opening registration gets the same general-channel announcement, minus the DM half.** There is nobody registered yet to direct-message — the whole point of the post is to reach people who have not joined. `PlayerNotificationPort.registrationOpened` and `checkinOpened` therefore share one `postToGeneralChannel` helper in the adapter and differ only in whether a DM pass follows.

**Every individual `/join` and `/checkin` also posts to the general channel** — who just joined or checked in, plus a reminder of the command for anyone reading who hasn't yet (`entrantJoined`/`entrantCheckedIn`). Unlike the window-opening announcements, these fire once per entrant rather than once per tournament, so a large field is a burst of general-channel traffic — accepted as the cost of keeping registration visible in the channel competitors already watch, the same tradeoff "The duplication is the design, not redundancy to optimise away" makes for result forwarding.

### Logging changes to organizers

Every tournament lifecycle transition (`/tournament create`/`open-registration`/`close-registration`/`open-checkin`/`close-checkin`/`start`/`cancel`/`rename`) and every roster change (`/join`, `/checkin`, `/leave`, and each `/roster` action) posts one line to the organizer alert channel, attributed to who did it. This is a plain activity log, not an escalation — no ruling buttons, nothing to resolve — so the command layer reuses `AlertPort.raise` as a bare post via a small `logToOrganizers` helper rather than routing it through the resolve-in-place machinery "Two classes, one inbox" describes below. A no-op confirmation (already joined, already checked in) is not a change and is not logged.

**Naming differs by audience.** The organizer alert channel is private and names people by their **raw Discord username** — the identifier that actually disambiguates someone in a moderation context, where two members can share a display name (or an empty one). The general-channel announcements (`registrationOpened`/`checkinOpened`/`entrantJoined`/`entrantCheckedIn`) are public and use the **server display name** instead, matching every other player-facing surface. `/roster`'s ephemeral reply — visible only to the organizer who ran it — also uses the display name, since it is not a channel post at all and reads more naturally that way; only the alert-channel line switches to username.

## Tournament Lifecycle

Every transition is an explicit action by someone at Tournament Organizer tier or above. Nothing is on a timer, and the state machine is the guard. Referees hold none of these — they rule on matches inside a running tournament, they do not move it between states.

```
DRAFT ─► REGISTRATION_OPEN ─► REGISTRATION_CLOSED ─► CHECKIN_OPEN ─► CHECKIN_CLOSED ─► RUNNING ─► COMPLETE
```

Every state in that diagram, `DRAFT` included, holds the guild's one tournament slot; only `COMPLETE` and `CANCELLED` (reachable from anywhere left of `RUNNING`) release it.

| Transition | Actor | Guard | Effect |
| --- | --- | --- | --- |
| `— → DRAFT` | TO | No tournament already held by this guild | Claims the guild's tournament slot — see below |
| `DRAFT → REGISTRATION_OPEN`, or `REGISTRATION_CLOSED`/`CHECKIN_OPEN`/`CHECKIN_CLOSED → REGISTRATION_OPEN` | TO | Guild configured; format chosen | `/join` starts (or resumes) working; check-in stops accepting `/checkin` if it was open |
| `REGISTRATION_OPEN → REGISTRATION_CLOSED`, or `CHECKIN_OPEN → REGISTRATION_CLOSED` | TO | — | `/join` stops working |
| `REGISTRATION_CLOSED → CHECKIN_OPEN`, or `CHECKIN_CLOSED → CHECKIN_OPEN` | TO | — | `/checkin` starts (or resumes) working |
| `CHECKIN_OPEN → CHECKIN_CLOSED` | TO | — | Pure state flip. No status or seed changes — `checkedIn` already records who was dropped, and seeding stays open |
| `→ RUNNING` | TO | At least 2 checked-in entrants; **Discord permission preflight passes** | Un-checked-in entrants dropped, their seeds cleared, and the survivors renumbered from 1 in relative order; bracket generated, threads provisioned, players notified |
| `→ COMPLETE` | bot | Grand final committed | Standings posted, public archive frozen; releases the slot |

**`close-registration` and `open-checkin` each also run one step in reverse** — accepting either their ordinary predecessor state or the state their own target normally leads to next, landing on the same target either way. Concretely: `close-registration` undoes an `open-checkin` that ran too early (from `CHECKIN_OPEN`, back to `REGISTRATION_CLOSED`); `open-checkin` undoes a `close-checkin` that ran too early (from `CHECKIN_CLOSED`, back to `CHECKIN_OPEN`).

**`open-registration` goes further: any state from `REGISTRATION_CLOSED` through `CHECKIN_CLOSED` reopens it**, not just the one immediately before. This is deliberately wider than the one-step reversals above — reopening registration after check-in has already opened, or even closed, is a real correction (the field needs to grow again, or check-in started too early), not a single miskeyed command to undo. There is no bulk recovery for anyone who withdrew or was dropped since; re-adding them is `/roster add`'s job, same as any other late addition — accepted as the cost of not building a second, bespoke recovery path for a rare correction.

None of these touch `Entrant` rows, `open-registration`'s wider reach included — a reversal is a bare state-enum flip, and whatever `checkedIn`/`seed` values exist keep meaning exactly what they meant, ready for the ordinary forward path to pick back up correctly once the TO moves forward again.

**`start` and `COMPLETE` do not get this treatment.** Undoing either would mean unwinding a materialized bracket, provisioned threads, and (past `COMPLETE`) posted results and a frozen archive — a different order of operation entirely from flipping an enum, and not something this build order has attempted.

**`/tournament rename`** works in any state short of `COMPLETE` or `CANCELLED` — the same span the tournament holds the slot for. It changes nothing but the name; no other field or transition is touched.

**There is no separate `SEEDED` state, deliberately.** An earlier draft had one, recording that a TO had reviewed and committed the seed order before starting. It gated nothing and froze nothing — `/leave` works until the tournament starts, so a player could withdraw after the commit, renumbering the field while the tournament still claimed the order was confirmed. A state asserting a fact that can quietly stop being true is worse than no state.

Starting *is* the confirmation: the start action shows the final order for review, and generating the bracket fixes it. The drop-and-renumber that produces that final order runs as part of `→ RUNNING` itself — not as an assertion checking work some earlier transition already did, but as the one place it actually happens, since seeding stays fully open (see Seeding) all the way up to this exact moment.

`CANCELLED` is reachable from **any** pre-`COMPLETE` state at Tournament Organizer tier, `RUNNING` included — "for any number of reasons... a tournament may need to be cancelled midway." Cancelling before `RUNNING` is the bare state flip described so far. Cancelling a `RUNNING` tournament does one thing more, in the same transaction: every `Match` not already `COMPLETE` is force-completed as `CANCELLED` too — a third terminal match status alongside `COMPLETE` itself, added to `MatchStatus` for exactly this. A match someone already finished keeps its real result; nothing about it is touched. The command layer then closes out whichever of those cancelled matches had a live thread — a note posted in it, then archived, the same mechanism used for a thread closing on ordinary match completion — and announces the cancellation to the general channel, same as it does for every other lifecycle transition.

Either way, cancelling — like completing — frees the guild's slot for a new `/tournament create`. See "Three constraints Prisma cannot express" for how the slot itself is held and enforced.

**Nothing here is a reversal**, unlike the pre-`RUNNING` back-edges above: `CANCELLED` is terminal, same as `COMPLETE`, and there is no path out of it. What changed is only which *source* states `cancel` accepts — it now includes `RUNNING`, where it previously refused.

**Two things happen at the start transition and only one of them can block.** Permissions are re-checked and a missing one blocks with the exact list. A song pack below the recommended size warns and proceeds — the requirement is explicit that the warning never blocks. The threshold is **`recommendedPackSize` from the format**, not a constant: Bo5 asks for 10, and a format with a different draw asks for whatever it needs. Once a tournament can mix formats, the threshold is the maximum across those in use.

The start also asserts that **every generated match's `formatKey` resolves to a registered format**. It cannot fail today, since all matches are stamped from one default — but it is the check that turns a typo in a future per-round override into a refused start rather than a match that cannot be played.

**Bracket immutability is enforced by the state, not by convention.** Once `RUNNING`, the entrant and seed mutations are rejected at the service layer by a single guard reading `tournament.state`, so there is one place to be right rather than one per endpoint.

## The Discord Adapter

Everything in this section is Discord's constraint, not the domain's, which is why it is confined to one module.

### Privileged intents

Two of the requirements can only be met with privileged intents, and this is worth knowing before the bot is registered rather than after:

| Intent | Needed for | Privileged |
| --- | --- | --- |
| `Guilds` | Threads, channels, interactions | No |
| `GuildMessages` | Seeing that a message arrived in a match thread | No |
| `MessageContent` | **Seeing its attachments** — the result-screen photo | **Yes** |
| `GuildMembers` | `GuildMemberRemove` — "a competitor leaves the server mid-tournament" | **Yes** |

Without `MessageContent`, a message event in a guild arrives with `content`, `embeds`, `attachments`, `components` and `poll` all empty, so the bot cannot tell that a photo was posted.

**The gate is 10,000 unique users, not a guild count.** Below that, both intents are toggled in the developer portal. Above it — more than 10,000 unique users who can see the app across every server it is in — they require review, and **approved apps must reapply annually**. An older 100-server threshold is widely repeated and no longer applies. This is a real deployment constraint rather than a formality, and the annual reapplication in particular is the kind of thing that lapses quietly.

**If `MessageContent` is unavailable**, the photo requirement degrades rather than breaking: `PHOTO_OBSERVED` is never emitted, the winner-selection step does not wait on it, and the thread carries a standing instruction to post the photo. The evidence still lands in the thread; the bot just cannot confirm it. This is the fallback, not the plan.

### Required permissions

Preflight computes the missing set and names it at `/setup`, again at tournament start, and once more before each round's thread burst:

View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Embed Links, Read Message History — scoped per channel as set out in the `/setup` diagnostic. (`Attach Files` was dropped from this set — nothing in the bot ever sends a file; it only reads the photo attachments players post, which needs no permission of its own.)

`Manage Channels` and `Manage Roles` are **optional**, and the only optional permissions in the design. They let `/setup` create channels and repair overwrites; withheld, setup falls back to selection plus a diagnostic and nothing else changes.

`Manage Threads` is the one that surprises people. The bot needs it to archive a thread on completion; **every tier role** needs it too, on the matches channel, because it is what lets referees see private threads at all — checked separately at `/setup`.

### Inviting the bot

The invite link needs the `bot` and `applications.commands` OAuth2 scopes, plus the base guild-level permission set — the union of everything any channel in "Required permissions" above ever asks for, since an invite grants guild-level permissions and `/setup` (and each channel's own overwrites) refine them from there:

View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Embed Links, Read Message History, Add Reactions.

Two more are worth granting up front even though `/setup` degrades gracefully without them, per "optional" above:

- **Manage Channels** — lets `/setup channels` create the matches/alerts/results channels itself, correct by construction. Without it, `/setup` falls back to "point at a channel you created yourself" plus a diagnostic; nothing else breaks.
- **Manage Roles** — lets `/setup`'s repair flow add a missing overwrite for a tier role, and lets `/setup roles` create a tier role when one is omitted. Without it, repair reports what it can't fix instead of fixing it (per "narrower than it first appears" under Provisioning the channels), and role creation falls back the same way channel creation does.

Both intents in "Privileged intents" above (`MessageContent`, `GuildMembers`) also need toggling on in the Developer Portal's Bot tab before the token will authenticate at all — a one-time step per deployment, not per-server.

**Keep this list in sync with the code, not the other way around.** The permission sets actually enforced live in `discord/setup-diagnostic.ts` (`REQUIRED_BOT_PERMS`, `REQUIRED_TIER_ROLE_PERMS`) and the creation overwrite table in `discord/commands/setup.ts` (`OVERWRITE_TABLE`); if a future phase adds something the bot needs, it belongs in both places before it belongs here.

### The three-second rule

Discord kills an interaction that is not acknowledged within three seconds. Every handler therefore **defers first, works second** — `deferUpdate()` for a button that edits the match message in place, `deferReply({ ephemeral: true })` where the response is private, and the work (lock, validate, append, post) follows. This is not an optimization; a lock wait behind another player's action can easily exceed three seconds on its own.

**One exception, and it matters:** a tiebreak pick must never use `deferUpdate()`, because that path edits the message every viewer sees. See The tiebreak.

### Stateless components

Button `custom_id`s encode everything the handler needs: `v1:<matchId>:<action>:<arg>`. A cuid match ID is 25 characters, so this fits Discord's 100-character limit with room for chart IDs.

**No in-memory component registry, no collectors.** A collector is a promise held in one process; the requirement is that a restart mid-Protect/Veto resumes exactly where it left off, and a promise does not survive a restart. Stateless IDs plus validation against `pendingAction` mean the buttons posted by the previous process are still fully functional after a deploy.

### Thread provisioning

Round 1 of a 32-entrant tournament creates 16 private threads at once, each with its two competitors added. Referees are not added — the tier roles' `Manage Threads` covers visibility — so a thread has exactly two members regardless of the size of the referee pool. That is still a burst against per-channel rate limits.

Provisioning runs through a **serialized queue with backoff on 429**, keyed by match ID and idempotent: a match with a `threadId` is skipped. Tournament start returns as soon as the bracket is committed; threads materialize behind it. Players are notified when their own thread exists, so nobody waits on the whole batch.

**Round 1 is not the only round that needs this.** `provisionReadyThreads` runs a second time from `applyAppendResult` (`match-event-effects.ts`), every time a match decides — advancement can seat two real players into a brand-new match at any round, not just the first, and that match needs a thread exactly the same way round 1's did. Idempotency is what makes calling it this opportunistically safe: a decision that didn't start anything new just finds an empty `ready` list. There is no reconciler yet — a crash mid-burst does *not* currently resume on boot; that is still the deferred piece "The reconciler" describes.

### Notifying players, and the channels

**Match-ready lands twice: a mention in the thread, and a direct message.** Being added to a private thread already notifies, but the mention makes it unmissable and the DM reaches someone who has the server muted.

**The DM is best-effort and cannot be made reliable.** Discord lets a user refuse DMs from server members; the bot cannot detect that in advance, and the send fails with `50007 Cannot send messages to this user`. A second code matters here too: **`50278`, "Cannot send messages to this user due to having no mutual guilds"**, which is what arrives when the recipient has left the server — a case this system meets routinely, since a player can leave mid-tournament. Both are treated as expected outcomes, not errors: logged at debug, never retried, no alert raised. **The thread mention is the notification of record** — nothing depends on the DM arriving, which is what keeps the privacy setting from becoming a support burden.

**The matches channel body carries nothing.** It hosts threads and holds the permissions that make them work — the bot's send and thread permissions, and the `Manage Threads` that gives organizers visibility. No message is ever posted in it.

That has a consequence worth stating, because a server will hit it: **#matches looks empty to everyone.** Private threads are invisible to non-members, and thread visibility requires `View Channel` on the parent, so the channel cannot be hidden from potential competitors — anyone may `/join`. A visible, permanently empty channel is the price of hosting threads somewhere.

**Results go to their own channel, one embed per finished match** (`buildResultAnnouncement`, `render/result-summary.ts`), colored white. The title — `{round} — {Player A} vs {Player B}`, both names in seat order regardless of who won — is the whole embed's link target (`setURL`) to the match's page on the public bracket; Discord embed titles carry no inline markdown, so "the match name as a hyperlink" is necessarily the *entire* title linked, not a styled span within it. The description is `{winner} advances ({winner score}-{loser score})`, then a blank line, then the tournament name linked to its own page (`[{tournament name}](tournamentUrl)`, which description fields *do* render as a real link, unlike the title).

- **Byes are excluded.** A walkover with no opponent is bracket structure, not a result, and posting it would fill the channel at exactly the moment round one is busiest.
- **Forfeits, disqualifications and walkovers post the same line as an ordinary decision** — worded as advancement uniformly rather than switching to a "defeats" verdict only for a played-out set. The score is whatever `points` holds either way, 0–0 for a match that never saw a song.

**Each result line is then forwarded to the general channel**, using Discord's native message forward — a `message_reference` of type `FORWARD` — rather than a re-post. The forward renders with its provenance and links back, so the results channel stays the chronological record and the general channel gets visibility without becoming a second, divergent copy. If the forward fails the result still stands in the results channel, so it is logged and not retried; the record is already correct.

**The duplication is the design, not redundancy to optimise away.** The two channels serve two audiences: the results channel is a conversation-free chronological log, which is what makes it readable to an organizer tracking an event in progress; the forward into the general channel is where competitors react and talk, without that traffic burying the log. Collapsing them into one costs whichever audience loses — a log nobody can skim, or a result feed nobody sees.

**The forward is optional and never blocks setup.** With no general channel set, results post to the results channel and nothing is forwarded. The organizer-facing half is unaffected; competitors follow the event on the public bracket, which is the surface requirements point them at anyway. Only the general channel is skippable — the results channel holds the log, so it stays required.

**Two configurations cause avoidable trouble**, and both are now handled by provisioning rather than by asking nicely:

- **Public threads in the matches channel.** Referees find match threads through that channel's thread list. Public discussion threads land in the same list, cluttering the one navigation surface used during an event.
- **Chat in the results channel.** A line appearing there is meant to mean something concluded; interleaved conversation removes the property that makes the log worth keeping. Reactions stay enabled — the discussion they might otherwise become already has a home in the general channel.

### Provisioning the channels

`/setup` offers, per channel, either **create it** or **point at an existing one**.

**Creating is the recommended path**, because a channel the bot makes is correct by construction and the administrator never has to learn Discord's permission model:

| Channel | `@everyone` | Tier roles | Bot |
| --- | --- | --- | --- |
| Matches | View; **deny** Send, Create Public Threads, Create Private Threads | View, Manage Threads | Full thread-capable set |
| Organizer alerts | **deny** View | View, Read History | Send, Embed Links |
| Results | View, Add Reactions; **deny** Send, Create Public Threads, Create Private Threads | — | Send, Embed Links |

`@everyone` keeps View on the matches and results channels deliberately — thread visibility requires View on the parent, and anyone may `/join`; results is meant to be read (and reacted to). Both are otherwise read-only: `@everyone` can neither post in the channel body nor start a thread of either kind there. That denial is scoped to the parent channel, not the private match threads under it — sending inside a thread is `SendMessagesInThreads`, a separate permission the two competitors get by being added to their own thread, untouched by what `@everyone` can do at the parent. The general channel is never created — every server already has one, and making a second is not a service.

**Every created channel lands under a "Tournament" category**, found or created once per `/setup channels` run and reused across all three — never a duplicate category on a re-run. This applies only to channels this bot creates; a channel an administrator points at instead stays wherever it already lives, unmoved.

**A configured channel that Discord no longer has is treated as unconfigured.** `/setup channels` re-checks every already-configured slot before deciding anything: if the stored channel id was deleted out from under it, that slot falls through to "point at what was given this run, or create fresh" exactly as if it had never been set — never silently left pointing at nothing. The diagnostic (`/setup status` and every `/setup channels`/`roles` reply) reports the same gap on its own, naming which slot's channel is gone, for the case where nobody has re-run `/setup channels` yet to pick up the drift.

**Pointing at an existing channel accepts any choice**, then computes the gap and **offers to repair it**, showing exactly which overwrites would be added before touching anything. Nothing is modified without confirmation: silently rewriting permissions on a channel a server already uses is not something a bot should do unprompted.

### Provisioning the roles

`/setup roles` offers the create-or-point-at choice for its **only two** tiers, Referee and Tournament Organizer: give a role, or omit it and let the bot create one, named for the tier (`Referee`, `Tournament Organizer`) and mentionable — so the escalation mention in the alert channel actually pings, which a non-mentionable role would otherwise silence for anyone without `Mention @everyone, @here, and All Roles`. A created role carries no guild-level permissions of its own; everything it needs is the channel-level overwrite `/setup channels` already grants it (or `/setup roles`' own re-diagnostic offers to repair, if the role is created after the channels already exist).

**There is no third option, for Server Administrator or otherwise — `/setup roles` has nothing to configure there at all.** Reconfiguring the server is Manage Guild, not a bound role (see Bootstrap and Two things called "administrator", above); there is no slot to bind, point at, or create, and no such requirement in the diagnostic.

**Membership is never provisioned, only the role itself.** Assigning members to a tier role remains entirely manual, in Discord — see "Granting access" below; nothing here changes that.

**A configured role that Discord no longer has is treated as unconfigured**, the same reasoning as a deleted channel: `/setup roles` re-checks every already-bound slot first, and a role deleted out from under it falls through to "point at what was given this run, or create fresh." The diagnostic reports the same gap on its own too — `/setup status` and every `/setup channels`/`roles` reply names which tier role is gone, the same way it names a gone channel, for the case where nobody has re-run `/setup roles` yet to pick up the drift.

**What bounds repair is narrower than it first appears.** A bot may only allow or deny permissions it holds in the guild or the parent channel — **unless it has a `Manage Roles` overwrite in that channel**, which lifts the ceiling entirely. So the practical rule is: with a channel-level `Manage Roles` overwrite the bot can grant `Manage Threads` to a tier role regardless of its own guild permissions; without one, it cannot exceed what it already has.

**Role hierarchy is a different matter, and an open question.** Discord documents hierarchy as governing role grants, role edits, role sorting, and kick/ban/nickname — and states that permissions otherwise do not obey it. Channel permission overwrites are not in that list. Whether a bot can edit an overwrite targeting a role above its own is therefore **unverified in either direction**, and the Discord spike should settle it empirically before repair is built to assume one answer.

Whatever cannot be repaired is reported instead, naming the layer that lost the permission.

**Repair never blocks the selection.** An administrator who declines the fix, or hits something the bot cannot repair, still gets their configuration saved with a list of what remains outstanding. Tournament start is still the gate, for the reason it always was: a stale configuration causes harm there, not at selection time.

### Ephemerality

Tiebreak picks are confirmed with an ephemeral reply and nothing else. The thread message shows *that* a player has chosen — never what. See Public Projections for the enforcement.

## Timers

Timers are alert thresholds, not enforcement: expiry raises an alert and changes no match state.

**They are database rows swept by a poller, not `setTimeout`.** A `setTimeout` is lost on restart, and "no tournament state is lost across a bot restart" covers a 25-minute match limit set five minutes before a deploy. A `Timer` row survives.

The sweeper runs every 15 seconds and claims due rows atomically:

```sql
UPDATE "Timer" SET "firedAt" = now()
WHERE id IN (
  SELECT id FROM "Timer"
  WHERE "fireAt" <= now() AND "firedAt" IS NULL AND "cancelledAt" IS NULL
  ORDER BY "fireAt" FOR UPDATE SKIP LOCKED LIMIT 50
) RETURNING *;
```

`SKIP LOCKED` is not needed today with one process, but it costs nothing and makes a second instance safe rather than duplicating every alert.

**Considered and rejected: BullMQ.** It is the standard answer and it needs Redis, which this design argues against elsewhere for the same reason. Two timer kinds at tens-of-rows scale do not justify a second service in Compose and a second failure mode during a live event.

**Both timers are created when the thread exists and both players have been notified** — specifically, once the in-thread mention has posted. Not when the bracket materializes its rows, which for a round-five match would set a 25-minute clock hours before anyone could play, and not at thread creation alone: a player cannot be held to a window nobody has told them about.

Two details make that anchor the right one. Thread provisioning runs through a **serialized queue**, so at round start sixteen threads appear over some seconds — pinning each clock to its own notification rather than to the round beginning keeps the allocation equal per match. And the **thread mention is the notification of record**, not the DM, which is best-effort and may fail entirely: a clock must not depend on a delivery the design already treats as optional.

Starting the time limit at readiness rather than at first song means it covers getting started as well as playing. That is deliberate: it is the schedule allocation for the match's slot, which is also why it matches the per-match figure the duration estimate multiplies.

**Each timer fires at most once**, guaranteed by `firedAt` plus the unique `(matchId, kind)` — a match cannot accumulate duplicate start-window alerts. Timers are cancelled, not deleted, when the match leaves the relevant phase: the start-window timer on the first `SONG_STARTED`, the time-limit timer on the set result. Keeping cancelled rows means an alert that did not fire is still explicable afterwards.

**A timer flags a potential delay to whoever can act on it. It does nothing else, and two consequences are intended rather than overlooked:**

- **The clock does not pause while an organizer deliberates.** An escalation waiting eight minutes on a referee still counts against the match. The timer measures elapsed time against a schedule, not fault — the round is late either way, and the person who needs to know is the same person.
- **A match at fifty minutes is as quiet as one at twenty-six.** The threshold fires once and the organizer owns it from there. A second nag would be the bot chasing a human who has already been told, which is the same thing the automation boundary forbids it doing to players.

**Overdue timers at boot fire immediately.** A deploy spanning an expiry produces a late alert rather than a missing one, which is the right failure for a threshold whose purpose is to get an organizer's attention.


## The Match Thread

The competitor-facing surface. Everything the rules require a player to do happens here, in a private thread holding two people and whatever the bot has posted.

### Creating the thread

**The name is `WR2 · Alice vs Bob · Storm 2026`** — bracket side and round, both competitors, then the tournament name. It sorts sensibly, identifies a match at a glance in a list of sixteen, and gives an organizer the two things they scan for; the tournament name at the end tells apart threads from different events for anyone whose thread list spans more than one — a player's own DM/thread history, or a bot administrator's. Display names are truncated to fit Discord's 100-character limit, longest first so both stay legible; the tournament name is appended last and never shortened by that pass, only hard-cut as a last resort if it alone doesn't fit even with both competitor names empty.

**The name is fixed at creation and never changes.** Renaming a thread hits a sublimit of roughly two changes per ten minutes — **undocumented, but consistently reproduced**, so the number should be read from the response headers rather than hardcoded, as Discord's rate-limit guidance instructs. A name carrying live state would therefore fall behind precisely when an event is busiest, which is the moment it would be worth having. State belongs in the thread, the bracket, and the results feed, none of which are constrained this way.

A grand final reset is a separate `Match` row and therefore a separate thread, named `GF2 · Alice vs Bob · Storm 2026`. It gets a fresh event log, so it gets a fresh place to live.

### Two kinds of bot message

**Log messages are permanent.** The Draw, each committed song result, each tiebreak reveal, the final summary. Posted once, never edited, never deleted — they are the thread's readable spine, and the reason someone scrolling back can reconstruct the match without opening the web app.

**The state message is singular and disposable.** Exactly one exists per thread at any moment. It carries the current prompt and the only live components in the thread, and it is replaced rather than accumulated.

The split matters because the two have opposite requirements: history wants messages to stay put, and a prompt wants to be where the player is looking. Trying to satisfy both with one message is what buries prompts.

### Keeping the prompt last

**Discord cannot move a message** — position follows the snowflake, and editing does not change it. Keeping a prompt at the bottom therefore means deleting it and posting it again. A bot may delete its own messages without `Manage Messages`, so this needs no extra permission.

The bot reposts when the state message is no longer the last message in the thread — which in practice means whenever a player posts a result photo — and edits in place when it still is. Editing is far cheaper and does not mark the thread unread, so the common case of a state change with nothing posted after it stays a single API call.

Four things this needs to get right:

- **Ignore its own messages.** A repost is a message create in the same thread; without a self-check the bot reposts in response to its own repost, forever.
- **Debounce.** Two photos landing together should produce one repost, not two. A short coalescing window — a second or so — collapses the burst.
- **Tolerate the click-during-delete race.** A player can press a component on a message that is being replaced; the interaction then fails as `10008 Unknown Message`. Expected, not an error: the action is re-driven from the new state message, and because components are stateless `custom_id`s the player loses nothing but a tap.
- **Repost, do not duplicate.** The thread must never hold two state messages. The message ID is tracked on `Match` alongside `threadId`, and delete-then-post runs as one guarded step so a crash between them is repaired by the boot reconciler rather than leaving an orphan.

**Nothing is lost by deleting prompts.** The event log is the system of record, the log messages carry the narrative, the photos are the players' own messages, and the result summary closes the thread. A deleted "your turn to Protect" prompt is not evidence of anything.

### Opening the match

The order matters and follows the requirements exactly: **the Draw is revealed before the higher seed chooses.** Whether to take the first or second Protect is a judgement about *these seven charts* — a Draw containing one dominant pick argues for going first — so choosing blind would remove the only content from the decision.

So a new thread produces, in order: both competitors added and mentioned; the Draw as a log message; then the first state message, holding two buttons for the higher seed. The lower seed sees who is deciding and waits.

There is no timer on the choice, as there is no timer on any player action. A seed who never picks stalls the match until the start-window threshold alerts the organizers.

### Presenting a chart

A chart carries more than fits on one line of a phone: playstyle prefix, title, subtitle, artist, meter, stepartist, description, source pack, flags. Two canonical forms, used everywhere:

**Transliteration resolves at display, not at import.** Both `title` and `titleTranslit` are stored, and `displayTitle()` in the shared package applies the `titleTranslit || title` precedence — one function, so no surface reimplements it. Keeping the original is what lets a search match either form, and it means the precedence stays a rendering decision rather than something baked irreversibly into the row at import.

**`difficulty` and `meter` are different things.** `difficulty` is the named slot — Expert. `meter` is the number — 12. The earlier names (`difficultySlot`, `rating`) made them look like two views of one value; they are independent, and both appear in the compact form as `SX 12`.

- **Compact** — `SX 12 · Vertex^` — for select-menu labels, inline references, and the results feed.
- **Full** — compact, plus stepartist, source pack, length and any flags — for embed fields and the Draw.

The playstyle prefix is always present and always leads, because it is the fastest way to tell a Singles chart from a Doubles one in a pack that may hold both.

### The Draw and Protect/Veto

The Draw posts as an **embed** — seven charts in full form, numbered, with the colour bar keyed to match state. It is a log message: posted once, never edited, still readable at the end of the match.

Selection uses a **string select menu**, not seven buttons. Discord allows five buttons per row, so seven charts means two ragged rows of labels capped at eighty characters — no room for meter, stepartist or flags, exactly the information that should inform a Veto. A select menu holds twenty-five options, each with a label and a description line, so the metadata sits with the choice rather than being cross-referenced by eye against the embed above. It is also one tap target rather than seven, which matters on the surface most of this happens on.

The menu is rebuilt at each step over only the **currently eligible** charts, so a chart already protected or vetoed cannot be picked. That is the same `PendingAction.choices` the format returns — the menu is a rendering of it, never a second copy of the rules.

**Flags surface at all three points requirements demand**: in the Draw embed against the chart, in the log message when that chart comes up to be played, and in the winner-selection prompt, where a flagged chart adds the settings-confirmation line and the *report a settings problem* button.

### Scoring a song

The state message for a song shows both players, the chart in full form, and per-player ticks for what has landed — EX% submitted, photo seen. *Submit score* is a button opening a modal with a single EX% field, validated to two decimals in `0.00`–`100.00` before it reaches the thread.

**Photo attribution is deliberately forgiving.** The first message from a player carrying an image attachment satisfies their photo requirement for the current song. Extras are ignored, images posted when nothing is outstanding are ignored, and the order against the EX% submission does not matter — a player standing at the results screen photographs first and types second, and a rule that discarded that photo would be fighting the only natural sequence.

Three details it needs: the attachment must be an **image** by content type, not merely any file; the check is per player, so one competitor cannot satisfy the other's requirement; and it depends on the `MessageContent` intent, without which the requirement degrades as described under Privileged intents.

If a photo never arrives the match simply waits. That is the automation boundary working as specified — the match-time-limit timer eventually raises an alert, and an organizer decides.

Winner selection appears only once both players have submitted and both photos have been observed. Three buttons: each player, or tie. The bot displays the comparison its own numbers imply but does not preselect — the committing fact is agreement, not arithmetic, for the reasons in the event catalog.

Disagreement escalates immediately. The state message becomes *awaiting an organizer*, its components are removed, and the thread waits — no retry, no timer, matching the automation boundary exactly.

**A ruling posts to the thread as a log message**, carrying the outcome, the referee's note if they left one, and **the referee's name**. The thread's audience is two competitors and the referee pool, so attribution there is accountability owed to people already in the room.

**The public match view says only "resolved by an organizer."** Naming a volunteer on a permanent public page beside a contested call is a deterrent to refereeing at all, and the accountability that matters — who ruled, when, with what note — is in `AuditLog` for anyone with cause to look. This is the one place the thread deliberately shows more than the public projection, and `toPublicMatch` is where the name is dropped.

### Resetting Protect/Veto

A referee may reset the sequence until song 1 has been played. **The Draw is unchanged; the protects and vetoes are cleared.** The requirement permits resetting *the sequence*, and the sequence is the picking — re-drawing would replace the seven charts both players had already read, which is a far larger intervention than the misclick that usually prompts a reset.

In the thread this is now unremarkable, because of the message split. The Draw was a log message and stays exactly where it is, still accurate. The old prompt was the state message, so it is replaced rather than lingering with stale components — the problem this once posed disappeared when prompts became singular and disposable. A log message records that a referee reset the sequence and that the Draw stands, and a fresh state message asks the higher seed to choose again.

The events are appended, never removed, so the public match view shows the abandoned picks followed by the reset and the real ones. Nothing rewinds, including this.

### The tiebreak

The one interaction where a leak is a rules failure rather than an annoyance.

**The select menu lives on the state message; the response is ephemeral.** The component is visible to both players, but a selection is private to whoever made it. The mechanism is worth knowing rather than trusting: the message object Discord stores is identical for every viewer, the only "selected" state in a select menu's payload is the developer-set `default` flag, and a user's own choice is client-local and **never persisted by Discord at all**. There is no per-viewer field that could leak.

**Which makes the response type load-bearing, not a detail.** Replying with `UPDATE_MESSAGE`, or deferring with `DEFERRED_UPDATE_MESSAGE` and then editing, mutates the shared message **for everyone**. A pick must be answered with an ephemeral reply — `deferReply({ ephemeral: true })`, then edit that ephemeral — and never with `deferUpdate()`, which is the reflex for a component sitting on a message the bot owns. The shared state message is updated separately, carrying only who has acted.

This is the one place the general defer-first rule has a wrong answer, and choosing it leaks a player's pick to their opponent without erroring.

**Because Discord persists nothing, the bot is the only record** — which the event log already handles, and which explains a behaviour that would otherwise look merely defensive. A player who refreshes loses the visual state of their own pick and will naturally try again; the refusal tells them what they chose rather than just turning them away.

**One residual, on the picker's own screen.** Their client keeps their selection highlighted in the menu until something refreshes it. Nothing about this reaches the opponent — it matters only where someone else can see the display, which means a streamed match, a screen share, or another person in the room. Narrow for a remote tournament, not empty.

It probably closes itself. The state message is **already edited** after each pick, to show that a player has acted; if that edit re-sends the select component, the client should discard its local selection along with the replaced payload. That is a claim about client rendering rather than documented API behaviour, so it is **a question for the Discord spike** rather than an assumption to build on.

**If it does not close itself**, the fallback is to move the picker out of the shared message: the state message carries a button, clicking it opens an ephemeral message containing the select, and the choice is made somewhere only that player can ever see. Nothing to highlight, because the shared message holds no select menu. The cost is a second interaction — which is why it is the fallback rather than the default, but the calculus changes if the highlight persists.

**What neither approach closes** is the ephemeral confirmation itself, which necessarily shows a player their own pick. Unavoidable, expected, and the same class of exposure as the highlight.

**The label has to say so plainly.** A picker sitting in a shared message will make people hesitate whatever the underlying behaviour, and a player who hesitates over whether their pick is about to be broadcast is a player who has been given a worse game. The prompt states that the choice is private and revealed only once both have chosen.

**The state message shows who has acted, never what they picked** — the projection rule from Public Projections and Hidden State, rendered. It edits as each pick lands, which reposts it if a photo has arrived since.

**Selections are final.** A second interaction from a player who has already chosen is refused ephemerally, saying what they picked so they are not left guessing. This is validation against `PendingAction` like everything else: once their choice is in the log, they are no longer an eligible actor for that round.

**The reveal is a log message**, posted once both picks exist: both selections, the rule applied — same chart plays, different charts means the unselected one plays — and the chart that results. Permanent, because by then it is history and the whole point of the mechanism is that it can be audited afterwards.

### Ending the match

The result summary is a log message: songs in play order with both EX% values and the winner of each, tiebreak rounds if any, and the final score. It is rendered from the same projection as the public match view, so the thread and the web page cannot disagree about what happened.

Whatever the state message was last showing — Protect/Veto, a score-submit button, "Confirm result," anything — is stale the instant the set decides: nothing is pending any more, no matter which event decided it. **It is left as-is rather than replaced** — the result summary embed just above it is already the closing signal, and posting a second "this match is decided" line under it was pure redundancy once the summary is guaranteed to always be the message directly before it (nothing else can post to the thread in between the two, in the same synchronous handler). A click on the stale prompt a moment too late is not silently swallowed: `appendMatchEvent` still refuses it regardless — `pendingAction` is `DONE` once terminal, so `isLegal` rejects the click — and the interaction handler's existing stale-match guard answers with an ephemeral "this match no longer exists," the same as any other action against an already-decided match. `handleCancel` (tournament.ts) is a different case — a tournament cancelled *out from under* a match still in progress — and keeps its own explicit log line, since that is new information, not a restatement of what a summary already said.

### Ending a match by referee ruling — `/dq`

A third way for a match to end, and the only one that goes through the ordinary event log rather than around it: `DQ_APPLIED` is a terminal `MatchEvent`, legal at any point before the match is `DONE` — see Match State and the Event Catalog. `/dq` builds one, appends it through the same `appendMatchEvent` a button click uses, and hands the result to `applyAppendResult` (extracted to `match-event-effects.ts` so the command layer can reuse it without an import cycle back through `commands/router.ts`) — the identical pipeline that renders the result summary, publishes the announcement, and archives the thread once `outcome()` turns terminal. A referee ruling and a mutually-agreed result are indistinguishable to everything downstream of the append; only the actor differs.

**There is no separate forfeit command.** A no-show or a player conceding is just `/dq` scoped to **this match only** — an ordinary loss, identical in every rendered and structural respect to a disciplinary disqualification at that scope. Discord originally shipped these as two commands (`/forfeit` and `/dq`), distinguished only by which vocabulary a referee reached for and which of two near-identical event types (`FORFEIT_APPLIED` vs. `DQ_APPLIED { scope: 'MATCH' }`) got appended; collapsing them removed a whole command, a render function, and a log-message variant for zero behavioural loss. `FORFEIT_APPLIED` stays in the domain — it is still a legal terminal event (see the Event Catalog), reserved for the organizer console's own forfeit action once that ships, per REQUIREMENTS.md's "referee-initiated actions (`/dq` and the web UI)" — but nothing on the Discord surface produces it any more.

`/dq` resolves the match via `loadMatchByThreadId` on the invoking thread and offers the scope choice REQUIREMENTS.md describes. **This match only** appends `DQ_APPLIED` with `scope: 'MATCH'` against that thread's match — the reducer resolves the *other* seated participant as the survivor (see the Event Catalog's `opponentOf` handling), so the command only ever needs the disqualified player's identity, never the winner's. **Whole tournament** instead resolves the tournament via `findActiveTournament` and calls `disqualifyFromTournament`, which sets the entrant `WITHDRAWN` and, if they were mid-set, appends the same `DQ_APPLIED` event with `scope: 'TOURNAMENT'` — but inside its own transaction, since the cascade it triggers has nothing to do with the thread the command happened to be run in. It hands back which match (if any) it resolved — `matchId`, the event, and the `AppendResult` — the same "report what changed, let the caller render it" shape `cancelTournament` uses for `cancelledMatchIds`, so the command layer can still post the thread log and run `applyAppendResult` even though the match that resolved may be nowhere near where `/dq` was typed. If the entrant had no live match — seated but not yet opposed, or not seated at all — `resolvedMatch` is `null` and nothing posts anywhere; the eventual walkover, once the bracket fills their slot, resolves itself lazily through the ordinary advancement path with no separate step to keep in sync.

`/dq` posts its own referee-attributed log line (`renderDqLog`) before calling `applyAppendResult`, the same division of labour `handleRulingButton` uses for an ordinary song ruling: only the command handler has the referee's identity to attribute the line to, so it posts that one line itself and leaves everything generic — the result summary, the announcement, the archive — to the shared pipeline.

**`player` is a `String` option with autocomplete, not Discord's `User` option.** A `User` option's picker only ever searches the guild's *current* member list — so a referee could never tag the exact player tournament-scope `/dq` exists for in the first place: "if a competitor leaves the Discord server mid-tournament... a referee applies the disqualification." Autocomplete (`handleDqAutocomplete`, dispatched from `interactions.ts`'s new `isAutocomplete()` branch) instead suggests from the tournament roster and resolves to `discordUserId`, which every DQ path already keys on internally regardless of live membership. Candidates depend on `scope`, read live off the not-yet-submitted interaction — `scope` is listed first in the command specifically so it is already chosen by the time a referee reaches `player` — this match's two participants for `scope: 'match'`, the tournament's whole active roster otherwise. Gated on nothing: `/roster list` already makes this same roster public, so autocomplete surfaces nothing a non-referee couldn't already see.

### Proactive song and set rulings — `/rule`

The web's referee-override panel (`referee-overrides.tsx`) has always rendered its Award/Void-song and award-the-set buttons whenever a match exists and isn't fully decided, with no check for whether a disagreement has actually happened — the freeze predicate itself (see "The override boundary is one predicate," above) never required one either. Discord had no equivalent: `SONG_RULED`/`SET_RESULT_RULED` were reachable only through buttons attached to an escalation alert message, which by construction cannot exist before a conflict. `/rule` closes that gap — the same capability the web UI already exposed, reached the same way `/dq` reaches its match.

`/rule song result:<choice>` resolves the match via `loadMatchByThreadId` on the invoking thread, exactly like `/dq`, and rules the song the match is currently on — `state.songs.find(s => !s.result)` — never a `songIndex` argument, so the two transports act on the identical target. `/rule set result:<choice>` rules the set's overall outcome directly, pre-empting whatever songs remain. Neither requires `AWAITING_TO`; both leave all other legality to `appendMatchEvent`'s own check, the same division `/dq` and the web ruling endpoint already use.

**`result` is a `String` option with autocomplete, not a fixed set of choices** — same reasoning as `/dq`'s `player` option: it needs to name one of this match's two participants, resolved to `discordUserId` regardless of live guild membership, plus `Tie`/`Void` for the song variant (matching `RulingRequest`'s schema, which allows neither for a set ruling). Event construction and the thread's referee-attributed log line reuse exactly what `handleRulingButton` already does for the same two event types, so a ruling made proactively from `/rule` and one made resolving a real escalation are indistinguishable to everything downstream of the append.

### Ending a match by tournament cancellation

A different, out-of-band way for a match to end: the whole tournament is cancelled while it's `RUNNING`. Unlike the ordinary ending above, this never touches the match's own event log — `cancelTournament` force-sets `Match.status` to `CANCELLED` directly, a status `MatchState`'s own reducer never produces and never needs to reason about. Whatever the match's `pendingAction` was at the moment of cancellation — Protect/Veto, a score submission, a tiebreak pick, anything — is simply abandoned; there is no terminal domain event for "the tournament ended out from under this match."

Cleanup is therefore two-layered. Proactively, cancellation posts a log line in the thread, replaces the live prompt with a plain, component-free message (clearing whatever buttons or select menu were last shown), and archives the thread — best-effort, acknowledging that Discord operations can fail partway through a batch the same way thread provisioning's own burst can (see "Thread provisioning" — there is no boot-time reconciler yet to resume either one). As a backstop, every interaction entry point checks `match.status === 'CANCELLED'` before doing anything else, ahead of even the participant/referee checks — so a stale click that survives the cleanup (a button visually still there, or an interaction already in flight when cancellation ran) is refused with "the tournament has been cancelled" rather than silently mutating a match the tournament no longer considers live. This check is deliberately on the cached `Match.status` column, not `pendingAction`, since a cancelled match's `MatchState` still looks perfectly ordinary — cancellation is administrative information the match's own state has no way to carry.

## Organizer Alerts and Escalation

Every stall in the system resolves here. The automation boundary guarantees the bot will wait forever rather than decide, which makes the alert channel the only thing that keeps an event moving.

It is a **shared work queue for a pool of referees**, not one organizer's inbox. That assumption shapes everything below: alerts must be glanceable so several people can triage without collision, resolution must be visible so nobody duplicates a ruling, and two people acting at once has to be ordinary rather than exceptional.

### Two classes, one inbox

**Escalations are derived; threshold alerts are rows.**

An escalated match is not a record somewhere — it is a match whose `pendingAction` is `AWAITING_TO`. Nothing separate exists that could disagree with it, and it stops being open the moment a ruling moves the state, for the same reason there are no commit events. The one concession to practicality is a cached `Match.awaitingTo` boolean maintained alongside `state`, so the organizer inbox is an index scan rather than a probe into JSON.

Timer expiry and a player leaving the server have no match state to derive from — nothing about the match changed, which is precisely the problem being reported. Those get `Alert` rows, deduplicated per tournament by a `dedupeKey` so a match cannot accumulate duplicate start-window alerts.

The organizer inbox is therefore a union of two queries. That is the cost of the split, and it buys the guarantee that an escalation and the match it describes can never diverge.

| Alert | Trigger | Class | Buttons |
| --- | --- | --- | --- |
| Song disagreement | Players selected different winners | Derived | Award A · Award B · Void song · Open in web UI |
| Settings violation | A player reported a flagged chart | Derived | Award A · Award B · Void song · Open in web UI |
| Match start overdue | Start-window timer | Row | Forfeit A · Forfeit B · Open in web UI · Dismiss |
| Match time exceeded | Time-limit timer | Row | Open in web UI · Dismiss |
| Player left the server | `GuildMemberRemove` | Row | DQ this match · Withdraw from tournament · Dismiss |
| Late withdrawal | `/leave` after check-in closed | Row | Open roster · Dismiss |
| Permission missing | An action failed on a revoked permission | Row | Open in web UI · Dismiss |

**Escalations mention every distinct role configured at Referee tier or above; threshold alerts post silently.** Deduplicated, so a server that has collapsed its tiers onto one role produces one mention. This reaches exactly the set of people entitled to act, which is what makes the mention correct rather than merely convenient.

**Every button here is Referee tier.** Ruling on a song, forfeiting a match, disqualifying a player — the whole alert channel is the referee's surface, and nothing in it requires a higher tier. That is the point of the tier: someone can be trusted to unblock a match without being trusted to start or cancel the tournament.

**Forfeit, DQ and withdrawal take a confirmation step** — an ephemeral confirm before the ruling lands. They are irreversible and they remove someone from a tournament; a single stray click in a channel is the wrong amount of friction. Awarding or voiding a song does not, because it is one song and the match continues.

### Resolution is an edit, not a reply

A resolved alert is edited in place: buttons removed, body replaced with who ruled and what they chose. The channel then reads as a live queue — anything still showing buttons is still open, which is the fastest triage available during a running event.

Threshold alerts resolve on an explicit dismissal **or** when their condition clears on its own — a start-overdue alert closes itself when the match starts, a departure alert closes when the player is DQ'd. Whichever happens first.

**The database is authoritative and the message is a view of it.** The ruling commits in its transaction; the message edit happens after, like every other side effect. If the edit fails — message deleted, rate limited — the ruling still stands, and the boot reconciler that re-posts missing match threads also re-syncs open alerts to the channel.

**Two referees clicking at once is already handled.** Both interactions serialize on the match row lock; the first appends its ruling, the second fails validation against a `pendingAction` that is no longer `AWAITING_TO`, and gets an ephemeral "already resolved by @X." Alert buttons are stateless `custom_id`s like every other button, so they survive a restart and a stale one is refused cleanly rather than erroring.

### Reporting a settings violation

Chart flags are enforced socially — the bot cannot observe a player's modifiers. Telling a referee directly still works, but relying on that alone leaves no structured path, and a referee then has to reconstruct which song and which chart from conversation. So there is a button.

On a chart carrying a flag, the score-verification step already prompts both players to confirm settings. It also carries a **report a settings problem** button. One click appends `SONG_ESCALATED` with reason `SETTINGS_VIOLATION`, the reporter as actor, and moves the match to `AWAITING_TO`. The alert arrives with the match, song index, chart, the flag in question, the reporter, and both submitted EX% values already attached.

The referee's options are exactly the ones requirements enumerate: award the song to the player who used the correct settings, or — when both were wrong, so there is no correct-settings player — select a winner or void the song, a void behaving like a tie.

**The button disappears once the song commits.** Requirements permit the forced result specifically "because the song has not yet been committed," so a violation noticed after both players agreed a winner is frozen like anything else. This is worth stating because it is the natural thing for a player to try, and the refusal needs to read as a rule rather than a bug.


## Realtime

The public bracket updates by push.

- Browsers subscribe to a tournament channel over a websocket: `tournament:{id}`.
- Domain services emit an internal event after committing a `MatchEvent`; `RealtimeModule` fans it out.
- Payloads carry **public** projections only — never a pending prisoner's-dilemma selection.

**Resync is by refetch, not replay.** Each frame carries `{ matchId, seq, projection }`. On connect or reconnect the client fetches the REST snapshot and then applies frames, dropping any whose `seq` is not greater than what it holds. The server keeps no per-client replay buffer and no missed-message queue: the snapshot endpoint already exists for the first page load, so reconnection reuses it. Frames are idempotent and safely dropped, which is what makes this sound.

Single-process topology means no cross-service pub/sub. If the bot is ever split out, this becomes Postgres `LISTEN/NOTIFY` or Redis pub/sub, and is the main thing that would need rework.

**Redis is deliberately not used.** It earns its place when there is cross-process shared state, pub/sub between services, or a database under enough load to need a cache. None apply: one process, in-memory fan-out, and an authorization query against a table of hundreds of rows serving a handful of concurrent organizers. Adding it now would mean a second service in Compose and a second failure mode during a live tournament, in exchange for nothing.

**The trigger to revisit** is splitting the bot into its own service. That is the point at which cross-process pub/sub becomes necessary and Redis becomes a reasonable answer — not before.

## Public Projections and Hidden State

The prisoner's dilemma is the one place where a leak is a rules failure rather than a privacy annoyance, and the requirement is precise: a player sees only their own choice, and the thread shows *that* a player has chosen without revealing what.

**One function guards it.** `toPublicMatch(state): PublicMatch` is the only way match state reaches a browser, a public API response, or a websocket frame. Nothing serializes `MatchState` directly. In a tiebreak round with fewer than two choices recorded, the projection emits `{ round, charts, chosenBy: EntrantId[] }` — who has acted, not what they picked. Once both land, the round is resolved and the full reveal is public, because by then it is history.

Concentrating this in one function is the point: the alternative is every endpoint and every frame independently remembering to strip a field, which is the kind of rule that holds until the day someone adds a new endpoint.

**It is property-tested.** For any event sequence, the serialized projection must not contain the chart ID of an unrevealed choice. This is checked over generated sequences rather than a handful of examples, because the failure mode is a field added later to a nested structure that the strip step never learned about.

The same projection backs the public match detail the requirements ask for — charts drawn, the full Protect/Veto sequence, per-song EX% and winners, tiebreak rounds, final result — so the public view and the realtime payloads cannot disagree about what is public.

**A second, smaller projection serves the bracket.** `toBracketMatch(state): BracketMatch` carries what a bracket cell renders — participants, `status`, running `points`, the chart currently being played, and the winner once there is one. It exists because the bracket shows live scores (see Rendering the bracket), so it changes on every committed song rather than only on completion, and shipping the full match detail for all sixty-odd cells on every frame would be wasteful. It is a narrowing of `toPublicMatch`, derived from the same state and covered by the same leak property test — not a second hand-maintained shape.

## Authentication and Authorization

- **Web:** Discord OAuth2. Session cookie carries the Discord user ID.
- **Discord:** interactions arrive with the invoking user ID already trusted.

Authorization is one service, transport-independent:

| Check | Source of truth |
| --- | --- |
| What tier does this user hold here? | Highest of the two `Guild.*RoleId` roles they hold |
| May they rule on a match? | Tier ≥ Referee |
| May they run a tournament? | Tier ≥ Tournament Organizer |
| May they reconfigure the bot here? | Holds Discord's Manage Guild permission — not a tier check at all |
| Is this user a bot administrator? | Config allowlist ∪ `Admin` table |
| May this user act in match M? | Is one of the two players, or holds Referee tier |
| May a referee override this song? | Not frozen — see Bracket Immutability |

**Config admins are re-applied additively at boot.** The boot pass upserts every ID in `ADMIN_DISCORD_IDS` into `Admin` and removes nobody, so editing the config and redeploying always restores access — the lockout recovery path the requirements specify. A row added through the web UI carries `addedByUserId`; one applied from the allowlist leaves it null, which is how the two provenances stay distinguishable in the audit trail.

Rows may be deleted, but deleting one that is also in the allowlist only lasts until the next boot. That is a feature of the recovery path rather than a flaw in it: the config file is deliberately the higher authority.

Public bracket and match history need **no authentication** — sign-in only adds a personalized dashboard.

**Sessions are a signed cookie carrying the Discord user ID**, and nothing else. There is no session table. (The `guilds` scope's OAuth token pair, added later for the homepage's server list, lives on `User` — see "OAuth requests `identify guilds`" above — not in the cookie and not in a new table.)

The reasoning shifted once tiers moved to Discord roles: authorization now reads tier from the gateway member cache, so a request costs **zero database queries** to authorize. A session table would therefore *add* a query rather than replace one, plus a table and an expiry sweep, to serve a handful of privileged users per server.

Revocation is already instant without it — removing someone's role locks them out on their next click, because nothing about their authority is stored in the cookie. Rotating `SESSION_SECRET` is a global logout. The one capability given up is killing a single session while leaving others alive, which is worth a table only if it becomes a real need rather than a hypothetical one; the authorization path does not change either way, so adopting one later is cheap.

**JWTs with embedded tiers were rejected outright.** Baking authority into a bearer token means a demoted referee keeps ruling until it expires, and the fix is a denylist — a session table with extra steps and worse ergonomics.

**The override boundary is one predicate per event, and none of them require a disagreement to already exist.** "A referee may act here" is `!state.songs[i].result` for a song ruling — still being played, or already escalated, makes no difference — `!state.terminal` for a set ruling, and `state.songs.length === 0` for a Protect/Veto reset. Both transports call the same function, so an override that is illegal in the web UI is illegal from an alert-channel button or `/rule`. A referee can therefore pre-empt the players' own agreement path at will, not only resolve a dispute they've already reached — the same "any time the match isn't done" precedent Forfeit and DQ already establish.

**Audit.** The rule is one line: **`AuditLog` records every action a tier permitted.** Referee rulings, roster changes made on a player's behalf, chart edits, tier role grants mirrored from `GUILD_MEMBER_UPDATE`, administrator promotions.

It does **not** record self-service acts any member could perform — a player's own `/join`, `/checkin` or `/leave`. Those are evidenced by their own effect, and logging them would bury the entries that matter under routine traffic. The test is whether privilege was used, because that is the question someone reviewing the log afterwards is actually asking.

Match-affecting referee actions are *also* `MatchEvent`s, since they change match state. The audit row is the cross-tournament, actor-oriented view of the same act — "what has Casey done today" rather than "what happened in this match".

## The Web Client

Two surfaces — the desktop-first organizer console and the mobile public bracket — built as one Vite app, split by route. The console's heavier dependencies (tables, drag-and-drop for seeding) load only under its routes, so a spectator on a phone never pays for them.

### API contract: REST, with zod as the only schema

Nest controllers, validated by zod through a validation pipe. The schemas live in a shared workspace package that both the server and the browser import, and the client's request and response types are `z.infer` of those same schemas — there is no parallel DTO layer to drift.

This is where the promise made at the top of this document is kept or quietly broken. "The chart schema is declared once and shared" means literally that the import endpoint validates against the module the client-side parser produces output for. One schema, two consumers, no codegen step between them.

| Route | Purpose |
| --- | --- |
| `GET /api/tournaments/:id` | Bracket snapshot — the resync fetch |
| `GET /api/matches/:id` | Public match detail, from the projection |
| `POST /api/tournaments/:id/charts` | Song pack import — the shared-schema endpoint |
| `POST /api/tournaments/:id/lifecycle` | Lifecycle transitions, guarded by the state machine |
| `POST /api/matches/:id/rulings` | Referee overrides, guarded by the freeze predicate |

**Considered and rejected: tRPC.** It gives the strongest end-to-end typing with no hand-written client, and on a TypeScript-everywhere project that is a real pull. But authorization here is deliberately transport-independent, wired on the HTTP side through Nest guards and DI — tRPC bypasses that and needs its own middleware layer, which means two places where an authorization check can be forgotten. Public reads also stay plain cacheable GETs this way.

**Considered and rejected: OpenAPI with a generated client.** It buys a documented, third-party-consumable API, and nothing in the requirements wants one — overlays and casting tools are explicit non-goals. It would also introduce a second schema system beside zod, which is the thing this section exists to avoid.

### Data layer: queries patched by frames

TanStack Query holds every read. The websocket connection is one subscription per tournament, and each frame — `{ matchId, seq, projection }` — is applied to the cache with `setQueryData`, dropping any frame whose `seq` is not newer than what is already there.

That is the resync model from Realtime, implemented rather than reinvented: `refetchOnReconnect` fetches the snapshot, frames patch it, and stale frames are idempotent. The reconnection story needs no bespoke code, which is the whole reason for the dependency.

**Override mutations invalidate; they do not update optimistically.** A referee override can be refused — the freeze predicate may have closed between render and click, exactly the race described in No commit events. Optimistically painting a bracket change that the server then rejects would show an organizer a result that never happened, on the surface where being wrong matters most.

### UI: Mantine, and only Mantine

No Tailwind and no second styling system. Mantine v7+ is CSS variables plus CSS Modules with no runtime style injection, and it is a complete styling story on its own.

Three reasons, in order of weight:

- **The console is forms and tables** — tournament config, roster, manual seeding, song pack editing, override dialogs. That is the bulk of the UI by volume and it is what a component library is for. Building it on unstyled primitives is work with no payoff here.
- **Mantine documents exactly one styling path.** Tailwind appears once across its entire documentation, on a page about the limitations of third-party styles; the Styles section documents CSS Modules, the Styles API, CSS variables, and style props at length. Pairing the two puts every customization off the documented path, and requires disabling Tailwind's preflight to stop the resets colliding.
- **Implementation will be substantially model-assisted, and Mantine publishes `llms.txt` / `llms-full.txt`.** That is worth real correctness — but only while the generated code stays on the grain of those docs. A Tailwind pairing spends the advantage it was adopted for.

Where Mantine contributes little — the bracket layout itself — the answer is plain CSS Modules written against Mantine's CSS variables, so there is still exactly one source of tokens.

**Considered and rejected: Tailwind with Radix or React Aria.** More rigorous accessibility auditing and a smaller public bundle, at the cost of hand-building every form control in the console. The audit edge matters less than it appears, for the reason in the next subsection.

### What accessibility conformance actually requires

The public bracket carries the formal WCAG 2.1 AA bar. Mantine covers the component-shaped parts — dialog focus trapping, labelling, escape handling. **Almost none of the real work is component-shaped**, and naming it here is the point, because it has to be budgeted rather than discovered:

- **Bracket semantics.** The bracket is a graph presented visually. It needs a structure a screen reader can traverse — rounds as nested lists, each match labelled with its participants, state, and score — not absolutely positioned divs whose meaning is purely spatial.
- **Keyboard traversal.** Moving between matches and between rounds without a pointer, with a visible focus indicator that survives the layout.
- **Announcing pushed updates.** Requirements say real-time updates must be announced rather than silently swapped in — but the bracket repaints on every committed song, and speaking every repaint would make the page unusable for exactly the people the requirement protects. Visual update frequency and announcement frequency are separate decisions; the policy is in Rendering the bracket below.
- **State not encoded in colour alone.** Winner, loser, in progress, and awaiting an organizer each need a non-colour cue.

This is also why the pan-and-zoom canvas approaches that most cleanly solve the mobile layout problem are hard to adopt: they tend to defeat all four.

### Rendering the bracket

The hardest UI problem in the project: 32 entrants produce 5 winners rounds, 8 losers rounds and the grand final pair — roughly 15 round-columns and 62 matches, to be read on a 375-pixel phone, on the surface carrying the formal accessibility bar.

**One semantic DOM, laid out by CSS Grid.** The markup is always an ordered list of rounds, each containing an ordered list of matches, regardless of viewport. Reading order and keyboard order are therefore correct everywhere by construction, and no layout decision can break them because layout is only ever CSS.

- **Wide viewports** place the grid as a conventional tree — winners bracket above, losers below, columns aligned by round so the two halves read against each other in time.
- **Narrow viewports** collapse the grid to a single column with a round selector, so a phone shows one round at a time rather than a scaled-down tree nobody can read.
- **Connectors are decoration.** The lines joining matches are an `aria-hidden` SVG layer painted behind the grid and recomputed on resize. They carry no information that is not already in the DOM, which is what makes it safe for them to be absent on narrow viewports.

**Rejected: pan-and-zoom canvas.** It is the approach that most cleanly solves fitting a wide tree onto a small screen, and it defeats all four accessibility obligations above at once — spatial-only meaning, no keyboard traversal, no reading order, nothing to announce into. **Rejected: a bracket library.** The ones that exist model single elimination well, double-elimination losers routing badly, and none target WCAG AA; the fight would be on precisely the two things that are hard requirements.

#### What a bracket cell shows

The bracket is live, not a record of who advanced. A cell carries both participants, the running score as songs commit — `0–0`, `1–0`, `2–1` — and the match state. Because the requirement forbids conveying state by colour alone, each state needs a text or icon cue: **pending**, **in progress**, **awaiting organizer**, **complete**, **walkover**.

#### What gets spoken

Everything repaints; almost nothing interrupts.

- **A `role="log"` region collects every change** — score commits, state transitions, advancements — for a screen reader user to read at their own pace. Nothing here interrupts.
- **The bracket's polite live region speaks only bracket-level events**: a match completing, a player advancing, a walkover applied.
- **Per-song score changes are spoken only in an open match detail view**, in that view's own region. The match a viewer deliberately opened talks to them; the other fifteen in the round do not.
- **A three-way verbosity control** — all updates / results only / off — is persisted in `localStorage`, wrapped in try/catch and defaulting to *results only* when storage is unavailable or empty.

The reasoning worth keeping: a strict reading of "all updates are announced" would fire dozens of interruptions a minute during a busy round, and the realistic outcome is the user muting the page or leaving. Collecting everything in a log satisfies the intent — nothing changes silently and unrecoverably — while reserving interruption for the events that change the tournament rather than the scoreline.

## The Organizer Console

Desktop-first, best-effort accessibility, and used by both tiers — what a person sees is filtered by `tierOf`, not by which console they opened. The one panel outside that filter is server reconfiguration, gated on Manage Guild the same way `/setup` is, not on a tier.

### The run view

The screen an organizer keeps open for three hours. Two panes.

**The alert queue** is the union described in Organizer Alerts and Escalation: matches whose cached `awaitingTo` is set, plus unresolved `Alert` rows. Ordered oldest-first, because the thing waiting longest is the thing holding up a round. Each entry carries the same actions as its Discord counterpart and resolves the same way, so a referee working from the browser and one working from the alert channel are operating one queue, not two.

**The live match list** is one row per in-progress match: round, both players, current chart, running score, and how long it has been going. Deliberately **not** the bracket tree — a tree explains structure, which nobody needs mid-round, whereas a list answers *which match is dragging* and *what is happening right now*. On a 32-entrant bracket the sixteen live matches are scattered across a wide tree and impossible to scan; as a list they sort by elapsed time and the slow one is at the top.

Both panes are fed by the same websocket subscription as the public bracket, patched by `seq`. The queue is the one place the console shows something the public projection does not — an escalation's reason, and who has claimed it.

### Match detail

One page per match, reachable from an alert, from the bracket, and from the match list. **Every override lives here.**

That is the point of having it: the freeze predicate is consulted in one place, so a ruling illegal from an alert-channel button is illegal here too, and a referee who spots a problem the bot never flagged has a path to act on it. The automation boundary guarantees the bot often *will not* flag anything — a match can sit silent indefinitely — so alert-only intervention would leave the most common failure unaddressable.

The page shows the full event log rendered, the current `pendingAction`, and the override controls the current state actually permits. Controls for frozen actions are not disabled-but-present; they are absent, because a greyed-out *award song* button on a committed song invites a support question about why it does not work.

### Seeding

The roster is the seeding interface — one ordered list, with each entrant's check-in state and whether their check-in DM was deliverable.

A player receives a seed automatically at the moment they join — the lowest-priority spot, at the back of the current order — rather than waiting on a TO to assign one. Check-in is its own column on that same list, not a grouping split: an entrant who hasn't checked in yet is still seeded, still reorderable, and stays that way for as long as the tournament hasn't started.

**Two ways to move someone, one underlying operation.** Dragging handles small adjustments; typing a seed number directly handles moving someone from 40 to 2, where dragging against a scrolling list is miserable. Both submit the same reorder, which writes the whole normalized order in one statement — which is what the deferred unique constraint exists for.

Dropping no-shows and collapsing the survivors' seeds to 1..N happens exactly once, at tournament start — not at check-in close, which is a pure state change. Until that moment, a late check-in or a withdrawal can still change the field, so there is nothing to keep "committed" earlier than the start action itself.

### Everything else

**Tournament configuration** is the lifecycle state machine rendered: current state, the transitions currently legal, and each one's guard shown as a checklist so a TO can see what is blocking a start before pressing it.

**Song pack management** is the pack tab's table with editing — the same filtering, plus inline edit, flag toggles, removal, and the import flow from Client-Side Song Pack Parsing.

**Bot administrators** get one extra surface: a list of every server the bot is in with its tournaments, and nothing else. It is read-only by construction — a Bot Administrator holds no tier in a server they have not been given a role in, so the console shows them the same match pages with no override controls.

## Results, Standings, and History

### Standings

Derived from elimination depth, never stored — see Advancement, Walkovers, and Standings. What remains is how they are presented.

**Tied players share a placement, and the next placement skips** — standard competition ranking. A sixteen-player field finishes 1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13. Two players eliminated in the same losers round have identical claims on the bracket, and inventing a tiebreak to separate them would assert something it never determined.

This falls out of the derivation rather than being applied on top of it: a placement is one plus the number of entrants eliminated strictly later, which *is* competition ranking. There is no separate tie-handling step to get wrong.

**The Discord post mirrors the match result feed** — full placement order to the results channel, forwarded to the general channel. The results channel then reads as a complete record of the event from first result to final standings, and the general channel gets the moment.

**Rendered as a green embed, deliberately larger than an ordinary result line** — title `🏆 {tournament name} — Final Standings`, the whole title linked to the tournament page (`setURL`), description capped at 8th place with ties sharing one line (`buildTournamentCompleteAnnouncement`, `render/tournament-complete.ts`). It reuses `computeTournamentStandings` directly, so it can never disagree with the standings page rendering the same tournament. Posted through `publishResult`, same as every other match result — the completing match *is* the natural anchor for it (the grand final, its reset, or the sole match a 2-entrant field ever plays), so it needs no channel-resolution path of its own.

**Fires off `AppendResult.tournamentCompleted`, not a state re-check.** Whether *this* match decided the tournament is not always obvious from the match alone — `persistAndCascade` (engine.ts) can complete the tournament several matches downstream of the one actually appended to, inside one transaction, when a tournament-scope DQ's walkover chain is what finally closes it out. The boolean threads back up through every recursive call (`startSeatedMatch` → `persistAndCascade` → `maybeStartMatch` → `startSeatedMatch`...) rather than being re-derived by polling `Tournament.state` before and after at the render layer, which would need to reason about which caller's "before" snapshot is actually still valid — `disqualifyFromTournament` commits its own transaction before the command layer ever loads the match `applyAppendResult` renders from, so there is no single "before" available to diff against there.

### Permanent URLs

`/t/:tournamentId` is the archive and never changes or gets reused. A server's landing page redirects to whichever tournament is currently active, or to the most recent one when nothing is running — so "the bracket" is always reachable without knowing an ID, while every past event keeps a stable address that a Discord message from a year ago still resolves.

Nothing is deleted at the end of an event. A finished tournament is a `COMPLETE` row that no longer occupies the guild's active slot, and its pages render from the same projections as when it was live.

### Player pages

`/g/:guildId/players/:discordUserId` — **keyed on the user ID, scoped to the server**, matching the requirement that history belongs to the server it happened in.

Keying on the ID rather than a name is what makes rename-safety work in practice: the page's own heading shows the player's *current* name from the `User` cache, while every row shows the name they competed under in that tournament, from `Entrant.displayName`. Someone who renamed mid-career sees one page, correctly labelled, with historical rows that still match the brackets they appear in.

The page carries their matches — opponent, round, score, link to the detail — and their win-loss record for that server. Nothing further: chart-level statistics are genuinely interesting for a rhythm game community and every one of them is a query and a surface to maintain, so they wait for someone to ask.

**Player pages are served `noindex`; brackets and match pages are not.** An event is worth finding by search. A permanent page that ranks for a person's name and enumerates every match they lost is a different proposition, and entering a tournament is not consent to it — the page stays fully public and linkable, it simply is not surfaced by a name search. The `X-Robots-Tag` header carries this rather than a meta tag alone, so it holds for any non-HTML representation too.

This is worth stating as a deliberate position rather than a default, because the natural implementation indexes everything and nobody notices until a competitor finds themselves in someone's search results.

### The dashboard

Signing in adds a single page: a link straight into your live match thread, your standing in the running tournament, and your past events in this server.

**Sign-in adds convenience and never capability.** Everything on the dashboard is reachable without an account — it is an assembled view of public pages, not a private one. That keeps the promise that nothing requires signing in, and it means the dashboard can never become the place a feature quietly lives.

It stays **scoped to one server**. A cross-server view is the one thing sign-in could offer that public pages cannot, and it is declined on purpose: history is scoped to the server it happened in, and joining across servers for a signed-in user would break a boundary the rest of the design maintains carefully.

## The Song Pack

### Snapshotting a chart

**A draw records the chart's metadata, not just its ID.** `DRAW_MADE` and `TIEBREAK_DRAWN` carry a `ChartSnapshot` per chart — the chart ID plus everything needed to render it in full form: both text forms of title, subtitle and artist, playstyle, difficulty, meter, stepartist, description, source pack, flags.

This exists because charts stay editable while a tournament runs. A wrong meter or a mistyped title discovered during play should be fixable, and a `Chart` row is referenced by ID from every event that touched it — so without a snapshot, correcting a row silently rewrites how every past match renders. Snapshotting separates the two concerns cleanly:

| Reads from | |
| --- | --- |
| The `Chart` row | The pack tab, the seeding and editing surfaces, every future draw |
| The snapshot in the event | Every match already drawn — thread messages, public match detail, result summaries |

**It is the same pattern as `Entrant.displayName`**, and for the same reason: reference data that mattered at a particular moment gets captured at that moment, so later corrections do not reach backwards into a record.

What falls out of it is that chart edits become safe enough to allow freely — audit-logged, but needing no freeze rule and no distinction between drawn and undrawn charts. A TO may even delete a played chart without damaging the record, since every match that used it renders from its own copy.

That is a different matter from the requirement that charts are *never removed once played*, which is not about editing at all — see Drawing Charts.

The cost is a few hundred bytes per draw event and two places a chart's metadata lives. That is worth naming plainly — it is denormalisation, chosen because the alternative is a record that can be edited after the fact.

### The pack tab

A tab on the public tournament view, at `/t/:tournamentId/pack`, carrying the same WCAG 2.1 AA obligations as the rest of that surface.

**The whole pack loads once and filters client-side.** Even a large pack is a few hundred rows of small objects, so there is no reason to round-trip a query per keystroke. The debounce is a render guard rather than a network one, which is why filtering feels instant.

**Search is one field across many.** It matches every text field a chart has, **original and transliterated alike** — a player searching *vertex sanxion* is combining a title and a stepartist and should get the chart, and one who types the romanised form of a Japanese title should get it as readily as one who pastes the original. `searchableText()` in the shared package assembles the haystack, so the search surface cannot drift from the fields a chart actually carries. Matching normalises case, diacritics and punctuation, then requires every typed token to appear somewhere in the chart's combined text, in any order. That covers partial and out-of-order words without the cost or the false positives of true edit-distance matching; typo tolerance can come later if anyone misses it.

**Filters adapt to the pack.**

- **Difficulty slot** and **rating** are always offered.
- **Playstyle** is hidden when the pack holds only one, since a filter with a single option is noise. A pack mixing Singles and Doubles is permitted and rare, so the common case gets the simpler UI.
- **`noCmod` is a checkbox**, not a general flag filter, because it is the only flag that exists. This is deliberate special-casing: a multi-select over a one-element set is worse UI, and generalising it is a small change on the day a second flag appears.

The playstyle *prefix* stays on every chart regardless — requirements make it part of how a chart is displayed, not a function of what else is in the pack.

**Announce the result count.** Filtering rewrites the list without any navigation, so a screen reader user gets no signal that anything happened. A polite live region reporting *"48 charts"* after the debounce settles is what makes the search usable rather than merely present — the same obligation as the bracket's pushed updates.

### `/pack`

Returns a link to the pack tab for the server's current tournament, answered ephemerally like every other competitor command.

With no tournament accepting entrants it says so rather than erroring. It resolves the *current* tournament only; a link to a past pack comes from that tournament's archived page, which is permanent anyway.

### Building and editing a pack

**For the first version, a pack is built by importing a StepMania folder or `.zip` and then editing the result in the web UI.** Bulk paste and file import of a chart list are deferred — importing a source pack and correcting it afterwards is how a pack actually gets assembled, and a paste format is a convenience that can be designed once the rest is in use.

Copying a pack from a previous tournament stays, since it is a server-side row copy with nothing to design and it is how a recurring event starts each edition. Reading that as distinct from "mass import" is a judgment call; it is a line of SQL either way.

Editing covers correcting any metadata field, setting or clearing flags, and removing charts. Every edit is audit-logged. Nothing about editing is gated on tournament state, because the snapshot makes it safe.

## Client-Side Song Pack Parsing

Simfiles never reach the server.

1. Browser reads a `.zip` or directory (File System Access API, with a `.zip` fallback).
2. A TypeScript `.sm`/`.ssc` parser extracts charts, resolving `titleTranslit || title` and friends at parse time.
3. The organizer reviews a **preview table** — charts found, duplicates flagged against the existing pack — and confirms.
4. Browser POSTs a JSON chart list.
5. **Server re-validates against the same shared zod schema** and persists.

The parser is shared code, but step 5 is not optional — the client fully controls that payload.

**Parsing runs in a Web Worker.** A full StepMania pack is hundreds of simfiles; parsing on the main thread freezes the tab for long enough to look broken.

**The parser (`packages/shared/src/simfile-parser.ts`) is a metadata-only scanner written for this project, not `simfile-parser` from npm** — an earlier draft of this document assumed that package before implementation surfaced why it doesn't fit. That package parses arrows, freezes, and BPM/stop timing for rendering a stepchart — real work this project never needs, since a tournament pack only cares about the metadata a chart is drawn and displayed by. It also drops `#CREDIT`/`#DESCRIPTION` entirely (its chart-tag allowlist is only `stepstype`/`difficulty`/`meter`), which `ChartInput` requires. A scanner that stops at the first note line is both simpler and the only one that produces what this pack model actually stores. It still handles the grammar that matters — `.sm` `#NOTES` blocks with colon-separated fields, `.ssc` `#NOTEDATA` sections with named tags — and the two coexist in a pack, often for the same song, so `.ssc` is preferred where both exist as the newer authored form (`pickPreferredSimfile`). Only `dance-single`/`dance-double` and the five named difficulty slots are recognised; an `Edit` chart or a non-`dance-*` stepstype has nowhere to go in this schema and is silently skipped, the same tolerance an organizer's later edit already covers.

The constraint to check it against is that **it must run in the browser**. Parsing is client-side in a Web Worker over an in-memory zip (`parseZipEntries`, grouping the zip's flat file list into song folders and parsing each one's preferred simfile) — the scanner itself takes only a filename and file content, no `fs` or directory walking, so the same function also backs the server-side directory-copy path (`pack-import.ts`'s `readPackDirectory`) used for local dev seeding.

**Three import rules sit on top of it:**

- **Both text forms are imported.** The parser yields `title` and `titleTranslit` separately and both are stored; resolution happens at display. An earlier draft resolved at parse time, which threw away the original and left search unable to match it.
- **`noCmod` is inferred from the title.** A case-insensitive search for `no cmod` across title and subtitle sets the flag, which is how packs actually mark the restriction. An organizer can set or clear it on any chart afterwards, so a miss is a correction rather than a failure.
- **Stepartist comes from `#CREDIT`, description from `#DESCRIPTION`.** They are distinct tags in `.ssc` and neither is reliably populated. A `.sm` chart has only the one field: it becomes the **stepartist**, and description is left empty. Since `.ssc` wins wherever both exist for a song, most charts in a modern pack take the two-tag path and `.sm`-only songs take the single one. Blanks stay blank; the editor is where they get filled in, which is a large part of why import-then-edit is the MVP flow rather than import alone.
- **Description is display-only and is not searchable.** It carries variant labels rather than anything a player looks a chart up by, and including it would return results for reasons invisible in the row that matched.

**Song length is not stored at all.** An earlier draft reconstructed it from the last note against the BPM and stop map, then kept it as optional metadata. Neither survives: nothing consumes it. The duration estimate is bracket depth times the per-match allocation and never reads a song length, and no player-facing surface shows one. A field with no reader is a field that drifts.

**Import is additive**, with client-side dedupe against the current pack keyed on title, subtitle, playstyle, difficulty slot, and rating. Charts are never removed once played, per the requirements, so the pack only grows during an event.

**Copying a pack from a previous tournament is a server-side row copy** — no parsing, no upload, and the copied rows are independent, so editing one tournament's pack cannot affect a finished one's history.

## Deployment

```yaml
services:
  app:      # NestJS: gateway + API + websockets + static build
  postgres:
```

Requirements: an always-on process (the gateway connection is persistent), public HTTPS for the OAuth callback, and the configuration below. Reverse proxy terminates TLS.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `DISCORD_TOKEN` | Gateway |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth |
| `DISCORD_OAUTH_REDIRECT_URL` | Must match the portal exactly |
| `SESSION_SECRET` | Cookie signing — rotating it is the global logout |
| `ADMIN_DISCORD_IDS` | Comma-separated allowlist, additive at boot |
| `PUBLIC_BASE_URL` | Links from Discord back into the web UI |

Config is validated at boot against a schema and the process refuses to start on a missing or malformed value — a bot that starts without `ADMIN_DISCORD_IDS` and silently has no administrators is worse than one that does not start.

Prisma migrations run on deploy. Backups are `pg_dump` on a schedule — self-hosted Postgres means this is yours to own. **Test the restore before the first real event**, not after.

## Failure Handling

Individual failures are handled where they arise, throughout this document. They all follow one rule, which is worth stating once because it is what makes them tractable.

### The database commits first; Discord is a projection of it

Every state change commits in its transaction, and **every side effect happens after** — posting to a thread, editing an alert, sending a DM. That ordering is chosen in Concurrency for a different reason, but it is also what bounds every failure in the system:

- **The record cannot be wrong.** A transaction commits or it does not. No Discord outcome can produce a state that did not happen.
- **The view can be stale**, and a stale view is always repairable, because the database can recompute what Discord ought to show.

**This is why there are no retry queues.** Durable retries exist to make an unreliable side effect eventually happen; reconciliation makes it eventually *correct*, which is strictly better and needs no queue, no dead-letter handling, and no ordering guarantees. It is also the second reason a job runner was not adopted, alongside the one in Timers.

### Expected failures are states, not errors

A substantial share of what Discord returns is not a fault but a configuration a user is entitled to choose. Treating these as errors produces alert noise that trains organizers to ignore alerts.

| Condition | Code | Treatment |
| --- | --- | --- |
| Player refuses DMs | `50007` | Expected. Debug log, no retry. The thread mention is the notification of record |
| Player has left the server | `50278` | Expected. Same handling; the departure alert covers the underlying situation |
| Component clicked as its message is replaced | `10008` | Expected. The action is re-driven from the new state message |
| Permission revoked mid-event | `50001`, `50013` | Alert naming the permission and the blocked action; retried when it returns |
| Rate limited | `429` | Queue backoff. Never surfaced to a user |
| Forward to the general channel fails | any | Logged. The record in the results channel is already correct |
| Thread or message deleted by a human | `10003`, `10008` | Reconciled if it should exist; accepted if it should not |

Everything else logs at error with the route and code, and is a bug until shown otherwise.

### The reconciler

Referenced in several places above; defined here. It answers one question — *does Discord match the database?* — and repairs the difference.

It runs **at boot**, and **every minute on the sweeper that already drives timers**. Boot alone would leave a failed thread creation missing until the next restart, which during a live event is the worst moment to need a deploy.

Each pass is a handful of indexed queries over the active tournament:

| Drift | Repair |
| --- | --- |
| Match ready, `threadId` null | Provision the thread |
| `awaitingTo` set, no open alert message | Post the alert |
| Alert resolved in the database, message still showing buttons | Edit the message |
| `pendingAction` live, state message missing or deleted | Repost it |
| `stateSeq` behind the match's highest event `seq` | Replay and repair the cache |

**Every repair is idempotent**, because each is phrased as *make Discord match the database* rather than *do the thing that failed*. Running twice is harmless, which is what allows it to run unsupervised on a timer.

**A crash between commit and side effect is exactly this case**, and needs no special handling: the transaction is durable, the side effect did not happen, and the next pass performs it.

**Batches are capped** so a pathological state — a tournament whose every thread is missing — produces steady progress and backoff rather than a burst against the global rate limit.

**What is not reconciled** is anything the database is not authoritative for. Result-screen photos live only in Discord; a deleted thread takes them with it. That risk is accepted in the requirements, and no amount of reconciliation touches it.

## Observability

Small, because the deployment is small — but a live tournament is the wrong time to be reading raw logs.

- **Structured JSON logs** with a correlation ID per interaction, carried from the Discord interaction ID or the HTTP request through to the committed event.
- **Every `MatchEvent` is logged at info** with match, type, and actor. This is the operational narrative of an event, and it already exists in the database — the log makes it greppable in real time.
- **Discord API failures log the route and the 429 bucket**, because the plausible live failure is rate limiting during thread provisioning.
- **A health endpoint** reporting database reachability, gateway connection state, and sweeper liveness.

Metrics and tracing are deferred. The trigger to add them is a second instance or an event large enough that "read the logs" stops working.

## Testing Strategy

| Layer | Approach |
| --- | --- |
| Format rules | Pure unit tests over event sequences. Highest value — this is where the rules live |
| Format stability | Golden replay: an archived-log corpus must reproduce identical committed outcomes |
| Play order | Property test: over every reachable state, the next song is uniquely determined — never zero candidates, never two |
| Bracket generation | Property tests: seed-neutrality of losers routing, bye placement, reset handling |
| Advancement | Property tests: a tournament-scope DQ at any point leaves every match resolved and exactly one champion |
| Draw utility | Property tests: exhaustion, undersized packs, and independence — a draw's distribution is unaffected by any prior draw |
| Public projection | Property test: no unrevealed tiebreak choice ever appears in serialized output |
| Duration estimate | DAG walk must equal the closed form for every entrant count |
| Services | Integration tests against a throwaway Postgres, including concurrent appends to one match |
| Alerts | Integration test: two referees ruling on one escalation leaves one ruling and one clean rejection |
| Transports | Thin enough to cover lightly |
| Public bracket a11y | Automated axe checks in CI, plus a keyboard-only traversal test |
| Simfile parser | Golden-file tests over a small corpus of real `.sm` and `.ssc` files |

The concurrency test is worth calling out: two simultaneous `SONG_WINNER_SELECTED` appends must produce two events with distinct seqs and one commit, and the same action submitted twice must produce one event. Both are cheap to write against a real database and impossible to check against a mock.

## Build Order

The dependency structure here is unusually favourable, and it is worth following rather than building outside-in.

**0. Optional Discord checks.** Documentation settles what is written down; a real server settles the rest. Four behaviours remain, none blocking.

| | Question | If the answer is not what we expect |
| --- | --- | --- |
| 1 | Can the bot edit a channel overwrite targeting a role positioned **above** its own highest role? | Nothing breaks. Repair reports what it cannot fix, and is already optional |
| 2 | After a tiebreak pick, does editing the shared state message clear that player's locally highlighted selection? | Nothing breaks. The picker moves behind a button into an ephemeral message, costing one interaction |
| 3 | Does delete-and-repost read acceptably when a photo lands mid-cycle, and does the debounce hold? | Nothing breaks. Repost on state change only, or accept burial with a jump link |
| 4 | Can the bot natively forward its own message, given forwarding requires the ability to read the source's content? | Nothing breaks. Post a copy in the general channel; loses provenance rendering, keeps the two-audience split |

**The one question that could have forced rework is already answered.** Verified by hand in a test server: a member with no roles cannot see a private thread they were never added to; give them a role carrying `Manage Threads` and they can. The tier model therefore holds, and the per-thread membership subsystem the role decision deleted stays deleted — no member adds, no backfill on grant, no membership reconciliation. That is confirmed behaviour now, not an inference from the permission table.

**Question 4 is answered too, and the expected answer held.** `discord.js` 14.27 exposes `Message#forward(channel)`, a thin wrapper over the native `message_reference` of type `FORWARD` — no read-the-source-content workaround needed. `publishResult` (`match-channel-adapter.ts`) sends to the results channel, then forwards that same message into the general channel when one is configured, wrapped in a try/catch per the documented failure handling: a forward failure is logged and not retried, since the result already stands in the results channel.

**Everything remaining is de-risking, not a prerequisite.** All four have a fallback already written into this document, which is less luck than it looks: expected failures are treated as states rather than errors, and self-provisioning is optional with a documented degradation path. Both were decided for other reasons.

**Nothing is blocked by deferring them.** Step 2 needs no Discord at all, and each of the four surfaces naturally during step 4 — the overwrite question in `/setup` repair, the select highlight in the first tiebreak, the repost feel in the first scored song, forwarding in the first result. Fixing them there costs a tuning pass rather than a rewrite, so a dedicated spike is optional.

**1. Schema and migrations.** Including the three raw-SQL constraints — the partial unique index for one active tournament per guild, and the deferrable unique constraint on `(tournamentId, seed)`. Getting those in the first migration avoids retrofitting them around existing data.

**2. The pure domain.** `MatchFormat` and `Bo5ProtectVetoFormat`, the draw utility, bracket generation, advancement, standings, the duration estimate. **None of this needs Discord, Postgres, or a running process** — it is pure functions over event sequences, and it is where nearly all the rules risk lives. The golden replay corpus starts here, as does every property test.

This is the step to do first and to do slowly. Everything after it is plumbing; this is the part that is genuinely hard to get right, and it is verifiable in complete isolation.

**3. Services and transactions.** The row lock, event append, cache and projection maintenance, the advancement cascade. Integration-tested against a throwaway Postgres, including the concurrent-append cases that cannot be checked against a mock.

**4. The Discord adapter.** The ports already have fakes from step 2, so this is the first point at which a token is needed at all. Interaction handling, the state message lifecycle, thread provisioning.

**5. Timers, alerts, the reconciler.** They depend on the adapter to have somewhere to post, and on the sweeper that timers introduce.

**6. Web API and client.** Last, because every projection it renders already exists and is tested by then.

**What this ordering buys** is that the two hardest things — the match rules and the bracket construction — are finished and property-tested before a single Discord credential is needed, and their tests keep running in milliseconds for the life of the project.

## Open Question

**Whether the `Match.state` JSON is worth keeping**, now that the projection columns exist.

Three things want match state, and they want different amounts of it:

| Need | Shape | Volume |
| --- | --- | --- |
| Validate an append | Full `MatchState` | One match, on the write path, under the row lock |
| Render one match — thread, match detail | Full `MatchState` | One match |
| Render many matches — bracket, run view, inbox | A few scalars | ~62 matches for a 32-entrant field |

**The projection columns are not optional.** The alert inbox filters on `awaitingTo`, and filtering an indexed boolean is not something a JSON column does well without an expression index nobody wants to maintain. The bracket and run view read six scalars per match; serving them from `state` means shipping and deserialising a multi-kilobyte blob per match to extract a handful of numbers. `awaitingTo` was added for exactly this reason — the others follow the same logic and should have arrived with it.

**The JSON blob is the genuinely optional part**, and its case rests on one thing: **avoiding a replay inside the transaction, while holding the row lock.** Every append must reduce current state to validate the action against `pendingAction`. With the cache that is one row read; without it, a replay of the match's fifty-odd events, on the hot write path, with the lock held. Single-match rendering could replay quite happily — it is the write path that makes the cache attractive.

Two things count against it:

- **It serialises a format-private structure.** `MatchState` belongs to `Bo5ProtectVetoFormat`. Renaming or adding a field is routine refactoring, and it invalidates every cached row — a change the golden replay corpus will not catch, because behaviour has not changed, only shape. The mitigation is to treat the column as **disposable**: null it on deploy and let it rebuild lazily on first touch. That removes the migration burden entirely, and is worth doing whether or not the column survives.
- **Verification is not free.** Checking `stateSeq` against the match's highest event `seq` is itself a query, so per-read verification gives back what the cache bought. In practice it is trusted — the row lock makes divergence impossible within a transaction — and the reconciler catches drift.

**Still deferred, and now for a specific measurement:** how long a replay-under-lock actually takes for a full match. If it is negligible, the blob is removable and the projection columns carry everything. Removing a cache is easy; adding one back on a guess is how caches become permanent without ever being justified.
