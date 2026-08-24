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
  formatKey   String                      // pluggable ruleset, see below
  config      Json                        // timers, per-match allocation
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

model Entrant {
  id            String  @id @default(cuid())
  tournamentId  String
  discordUserId String                    // identity — never changes
  displayName   String?                   // snapshot taken at tournament start
  seed          Int?
  checkedIn     Boolean @default(false)
  status        EntrantStatus             // ACTIVE | NOT_CHECKED_IN | WITHDRAWN
  @@unique([tournamentId, discordUserId])
  @@unique([tournamentId, seed])
}

model Chart {
  id             String  @id @default(cuid())
  tournamentId   String
  title          String                   // titleTranslit || title, resolved at import
  subtitle       String?
  artist         String?
  playStyle      PlayStyle                // SINGLE | DOUBLE
  difficultySlot DifficultySlot           // NOVICE..EXPERT
  rating         Int
  stepartist     String?
  sourcePack     String?
  lengthSeconds  Int?
  flags          String[]                 // ["noCmod"]
}

model Match {
  id           String  @id @default(cuid())
  tournamentId String
  bracket      BracketSide               // WINNERS | LOSERS | GRAND_FINAL
  round        Int
  slot         Int                       // position within the round
  playerAId    String?
  playerBId    String?
  threadId     String?                   // Discord thread
  state        Json                      // cached reduction, see below
  stateSeq     Int     @default(0)       // event seq the cache reflects
  alertMsgId   String?                   // open escalation message, for edit-in-place
  // --- projection columns: derived on write, for many-match queries ---
  status       MatchStatus               // PENDING | IN_PROGRESS | COMPLETE
  winnerId     String?
  awaitingTo   Boolean @default(false)   // pendingAction is AWAITING_TO
  pointsA      Int     @default(0)
  pointsB      Int     @default(0)
  currentChartId String?                 // chart being played, if any
  events       MatchEvent[]
  @@unique([tournamentId, bracket, round, slot])
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

### Three constraints Prisma cannot express

All three need raw SQL in a migration, and all three are worth the awkwardness because they enforce a requirement at the only level that cannot be bypassed by a bug in a service.

**One active tournament per guild.** A partial unique index:

```sql
CREATE UNIQUE INDEX one_active_tournament_per_guild
  ON "Tournament" ("guildId")
  WHERE "state" NOT IN ('DRAFT', 'COMPLETE', 'CANCELLED');
```

Drafts do not occupy the slot — a TO can prepare the next event while one is running, which the requirement's "cannot *start* until the current one finishes" permits. Everything from open registration through the grand final does.

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
  protects: { chart: ChartId; by: EntrantId }[];   // in protect order
  vetoes:   { chart: ChartId; by: EntrantId }[];
  decider?: ChartId;
  songs: SongRecord[];               // one per song started, in play order
  points: Record<EntrantId, number>;
  tiebreaks: TiebreakRound[];
  escalation?: { songIndex: number; reason: EscalationReason };
  confirmations: EntrantId[];        // set-result sign-off
  pending: PendingAction;
}

interface SongRecord {
  chart: ChartId;
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

`effects` exists because of the derived commit. Something has to notice that song 3 just became final so the thread gets a summary and the match time-limit timer is cancelled, and with no commit event to subscribe to, the alternative is the service comparing `before` and `after` itself — which means a service reasoning about format-specific state shape, exactly the coupling the plugin boundary exists to prevent. Returning a *description* of what to do keeps it pure and testable: `SongCommitted`, `TiebreakResolved`, `EscalationOpened`, `SetDecided`. The service interprets them after the transaction commits. Effects are match-scoped only — bracket advancement is the service's reaction to `outcome() !== null`, because a format has no business knowing brackets exist.

**All four functions are pure.** No database, no Discord, no clock. That makes the entire ruleset unit-testable by feeding it event sequences, which matters given how many edge cases the rules carry: ties awarding nothing, the play-order fall-through when a loser has neither a Protect nor the Decider left, reshuffling on an undersized song pack.

`PendingAction` is a discriminated union naming the actor and the legal choices:

```ts
type PendingAction =
  | { kind: 'SEED_CHOICE'; actor: EntrantId }
  | { kind: 'PROTECT' | 'VETO'; actor: EntrantId; choices: ChartId[] }
  | { kind: 'SUBMIT_SCORE'; actors: EntrantId[]; songIndex: number }
  | { kind: 'SELECT_WINNER'; actors: EntrantId[]; songIndex: number }
  | { kind: 'TIEBREAK_PICK'; actors: EntrantId[]; round: number; choices: ChartId[] }
  | { kind: 'CONFIRM_RESULT'; actors: EntrantId[] }
  | { kind: 'AWAITING_TO'; reason: EscalationReason }
  | { kind: 'DONE' };
```

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

### Format versioning and golden replay

Because commits are derived, an archived match's outcome is a function of its events **and** the reducer that reads them. A reducer edit could silently change what a finished tournament decided.

`formatKey` is stored on the tournament and replay always uses the format that ran the match, so a genuine rules change ships as a new key — `bo5-protect-veto-v2` — and leaves old matches reading the old rules.

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

**Algorithm.** The conventional double-elimination construction:

- Pad to the next power of two; byes go to the highest seeds.
- Winners rounds pair by standard seed distance, keeping top seeds apart as long as possible.
- Losers rounds alternate **minor** (losers-side survivors meet) and **major** (winners-side droppers enter) rounds.
- On each major round the drop order is transformed — alternating **reverse** and **rotate** by round — so players from the same winners-bracket region are separated.
- Grand final, plus a reset bracket if the losers-side finalist wins the first set.

The transformation is computed from **bracket positions alone at generation time** and never consults results.

**The whole bracket is materialized up front**, byes included, with `playerAId`/`playerBId` null where the occupant is not yet known. Advancement then writes a player into an existing row rather than creating matches on the fly, which keeps the public bracket renderable in full from the moment the tournament starts and makes the duration estimate a walk over real rows.

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

**Advancement runs in the same transaction as the event that decides the set.** With no `SET_COMMITTED` event to react to, the transaction that appends the second `SET_RESULT_CONFIRMED` sees `outcome()` turn non-null and advances before it commits — so "set decided ⟹ bracket advanced" is an invariant of the database rather than of a background job. The row count is small even for the withdrawal cascade below; a 64-entrant bracket holds 126 matches in total. Thread provisioning stays outside the transaction, because it is a network call, and is covered by the boot-time reconciler.

**Advancement is a bracket-side operation triggered by a committed set result.** The winner is written into the successor winners-side slot; the loser into the successor losers-side slot, or eliminated if they were already in the losers bracket. When both slots of a downstream match are filled, that match becomes ready and the thread is provisioned.

**A bye is a walkover, not a match.** Round 1 matches with one null occupant are settled by a `WALKOVER` event at generation time — the requirement's stated exemption from the automation boundary. No thread is created.

**Tournament-scope disqualification cascades.** `DQ_APPLIED` with scope `TOURNAMENT` sets the entrant to `WITHDRAWN` and then, in the same transaction, walks both brackets: every not-yet-started match where they occupy a slot resolves as a `WALKOVER` to the opponent, and each of those resolutions advances, which may itself fill another match containing them. The walk repeats until no match containing a withdrawn entrant remains unresolved. This is the single referee action the requirement asks for.

The one case needing care: if their *current, in-progress* match is mid-set, that match resolves as a forfeit — an ordinary loss — and then the cascade covers the losers-side path they would have dropped into.

**Grand final reset is a distinct match row, not a rerun.** It exists in the generated bracket from the start with `bracket = GRAND_FINAL, round = 2`, and is skipped by advancement when the winners-side finalist takes the first set. Because it is a separate row it gets a fresh event log, hence a fresh Draw and a full ABBAAB — which is exactly what the requirement asks for. Seed advantage reads from `Entrant.seed`, not from anything about the first set, so the winners-bracket finalist keeps the first-or-second Protect choice in both.

**Standings are derived, never stored.** Placement follows elimination depth: the grand final decides 1st and 2nd, the last losers round decides 3rd, and players eliminated in the same losers round share a placement (4th, then 5–6, 7–8, and so on). A query over `Match` grouped by the round in which each entrant took their second loss produces this directly; withdrawn entrants place by where their withdrawal landed them. Deriving rather than storing means a late referee ruling that changes a match also changes the standings, with nothing to invalidate.

## Duration Estimate

The requirement is a walk, not a formula: count the rounds that must happen **sequentially**, multiply by the per-match allocation, and add one round for a possible grand final reset.

Implemented as a **longest path through the match dependency DAG** — each match depends on the matches feeding its two slots, and the estimate is the depth of the deepest chain. Because every match in a round can run simultaneously (remote tournaments, no shared hardware), depth is the schedule.

For the standard shape this equals `2⌈log₂ n⌉ + 1` rounds including both grand final sets, which makes a clean test oracle: the DAG walk and the closed form must agree for every entrant count. If they ever diverge, the bracket generator produced a shape it should not have.

## Server Onboarding

### Bootstrap: the one place Discord permissions gate anything

A freshly-invited server has no configured tier roles, no tournament, and therefore no application-level authority. Something has to establish the first one.

**`/setup` is gated on Manage Guild *or* the Server Administrator role.** Whoever added the bot runs it first and names the three tier roles; from then on the configured administrators can re-run it themselves. The Manage Guild path is narrow by necessity — the administrator role cannot authorize the command that decides which role is the administrator role — and it remains as the recovery route.

**It is re-runnable, which makes it the per-server recovery path.** If a tier role is deleted, emptied, or misconfigured, anyone with Manage Guild can run `/setup` again and re-point the bot. That mirrors the config allowlist at the deployment level, giving two independent recovery routes at the right scopes — neither depending on the other, and neither requiring the operator to be a member of a server they are rescuing.

**Bot administrators stay view-only.** Requirements define their capability as seeing across servers, and with self-service bootstrap and self-service recovery they never need to reach into a server's referee pool. The role keeps exactly the scope the requirements give it.

### Three tiers of privilege

Authority is Discord role membership, resolved to one of three cumulative tiers. `/setup` points the bot at a role for each, stored on `Guild`.

**The capability list lives in REQUIREMENTS.md**, under *What each role may do*, and is not restated here. A second copy is a second thing to keep in step, and the one that drifts is always the copy — the same reasoning that removed commit events from the match log.

What belongs here is the mechanism:

**Tiers are cumulative and totally ordered**, so a check is `tierOf(member) >= required` rather than a set intersection. `tierOf` returns the highest tier whose role the member holds, and `required` is a constant on the action — one comparison, no per-capability bookkeeping, and adding an action means naming its tier rather than editing a matrix.

**The dividing line is refereeing versus running an event:** a referee unblocks matches but cannot create, start, or close a tournament. That falls out cleanly in implementation — everything reachable from the alert channel is Referee tier, everything in the lifecycle state machine is Tournament Organizer tier, and `/setup` is the only thing above it.

**Tournament-scope disqualification sits with referees, deliberately** — the one placement in that list worth arguing about. It is the most consequential thing at the tier, withdrawing an entrant and cascading walkovers through both brackets. It belongs there because it is conflict resolution rather than lifecycle: the tournament-scope option exists precisely so a player who has left for good is handled in one action instead of being disqualified again in the losers bracket, and making a referee escalate for it reintroduces the friction the option was added to remove. It is audit-logged like every other ruling.

#### Two things called "administrator"

The tiers above are **server-scoped**. Requirements also define a **Bot Administrator** that is deployment-scoped — able to see every server the bot is in — granted by the config allowlist and the `Admin` table, not by any Discord role.

They are unrelated and the collision is only in the word. This document uses **Server Administrator** for the tier and **Bot Administrator** for the deployment role, and nothing should be labelled plain "Administrator" in code or UI.

#### Servers may collapse the tiers

Nothing requires three distinct roles. A server can point two slots — or all three — at the same role and get exactly the flatter model it wants: one `@Staff` role in every slot reproduces the original single-tier design.

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

Requirements are explicit that it does not provision channels — it asks the organizer to create them, then points the bot at them. The same applies to the role.

1. Takes the matches channel, the organizer alert channel, and a role for each of the three tiers. The same role may be given for more than one tier.
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
| Bot, in the matches channel | View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Attach Files, Embed Links, Read Message History | Running matches at all |
| Bot, in the organizer alert channel | View Channel, Send Messages, Embed Links, Read Message History | Raising and editing alerts |
| Bot, in the results channel | View Channel, Send Messages, Embed Links | Posting the result feed |
| Bot, in the general channel, if set | View Channel, Send Messages, Embed Links | Forwarding results |
| Each tier role, in the matches channel | View Channel, Manage Threads | Seeing private match threads. Tier capability is ours; thread visibility is Discord's, and it does not inherit — a Server Administrator without `Manage Threads` can rule on a match they cannot read |
| Referee-tier role | At least one member | A tournament started with an empty referee pool has no way to resolve a dispute |

The last is a warning rather than a gap, since a server may legitimately configure roles before populating them.

**Re-checking is one click.** The diagnostic carries a *Re-check* button, so the loop is fix-in-Discord → click → see what remains, without retyping the selections. The same report is available any time from `/setup status` and in the web wizard, which renders it as a live checklist rather than a one-shot message.

### Granting access

**Tier access is granted in Discord, by assigning the relevant role.** There is no bot command and no web UI for it.

**Bot administrator promotion picks from signed-in users.** It is deployment-scoped, so there is no guild member list to pick from — the person being promoted may be in a different server entirely. Choosing from `User` rows is the only mechanism that does not degrade to typing an ID.

**Sign-in is information, never a gate.** A referee can rule entirely from Discord — alert buttons and slash commands are equal surfaces by requirement — so a referee who never opens the web UI is fully functional.

**OAuth requests `identify` only.** Which servers a user may act in is resolved from role membership in the gateway cache. Requesting `guilds` would add a broader consent prompt and a second, staler notion of "may act here" beside the one that already exists.

**The `User` table is a cache for current UI, never for history.** Requirements fix the display name as a snapshot taken at registration and stored per tournament, so past brackets show the name someone competed under. `User.displayName` serves organizer screens; rendering a bracket or match history from it would silently break that guarantee, and is the single most likely way to do so by accident.

### Permission drift during an event

Permissions are reported at `/setup` without blocking, enforced at tournament start where a missing one blocks the start, and checked **once more before each round's thread burst** — the highest-risk moment and the cheapest to guard, since one effective-permissions computation covers a burst of sixteen thread creations.

Everywhere else the adapter fails loud rather than pre-checking: a permission error is raised as an alert naming the missing permission and the action it blocked, and the operation retries once the permission returns. Polling for drift would mean recomputing two channels' permissions forever to catch a rare event, and would still miss the gap between the last poll and the next use.

### The first-run wizard

Requirements call for a guided wizard walking a new server through configuration, building a song pack, and creating its first tournament.

**It is a view over real records, not its own state machine.** Server configuration is the `Guild` row; the first tournament is a `Tournament` in `DRAFT`, which the lifecycle already defines and which explicitly does not occupy the server's active slot. A half-finished setup is therefore just a draft, resumable by construction — closing the tab loses nothing, and there is no wizard-progress table to keep in step with the records it describes.

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

### Leaving

`/leave` works from the moment registration opens until the tournament starts, and its consequences depend on when it lands.

**Before check-in closes** the roster is still fluid, so a withdrawal is silent: the entrant is marked `WITHDRAWN`, their seed cleared, and nothing else happens. Seed gaps do not matter yet — the normalization at check-in close will close them.

**After check-in closes** the field is settled and an organizer has been seeding against it. A withdrawal there **re-runs the normalization immediately** — clear the seed, renumber the survivors from 1 preserving order — and **raises an organizer alert**, because a TO who committed a seed order deserves to be told it changed rather than discovering it at bracket generation.

That difference is the cost of allowing `/leave` throughout, and it is worth paying explicitly rather than pretending the two cases are the same.

**A player may re-join only while registration is open.** After that, `/join` is closed to everyone including someone who left, so a change of heart during check-in needs an organizer.

### Acting on a player's behalf

**A Tournament Organizer can do anything a player can do for themselves**, to any entrant, until the tournament starts — add, check in, un-check-in, remove. Both from the console roster and from `/roster`, since organizers work from whichever surface is in front of them.

It is a **superset of the player's own window**, which is the point. `/join` closes when registration closes; a TO can still add someone who missed it, right up until the bracket is generated. Requirements only forbid adding entrants once the tournament has *started*.

**Tier is Tournament Organizer, not Referee.** Roster composition is tournament management rather than unblocking a match, and it sits with the tier that opens and closes the windows in the first place.

**Late additions re-run normalization**, exactly as late withdrawals do — a player added after check-in closed is appended unseeded, and committing seeds renumbers. They raise **no alert**, unlike a player's own `/leave`: the organizer performing the action already knows it happened, and an alert telling them what they just did is noise. That asymmetry is the whole reason the withdrawal alert exists — it reports a change the organizers did not make.

### Snapshotting the display name

`Entrant.displayName` is **null until the tournament starts**. Every surface before that — the roster, the seeding interface — reads the current name from the gateway member cache, which is exactly what the `User` table is for.

At start, the bot resolves each remaining entrant's name as Discord shows it — **server nickname, else global display name, else username** — and writes it into `Entrant`. From that moment it never changes, and every bracket, match record and history page renders from it.

If a member cannot be fetched at start, the last known name from `User` is used. That case means they have left the server, which the departure alert already handles; a missing name should not be the thing that blocks a tournament from starting.

### Calling check-in

Opening check-in posts an **announcement in the general channel with no mentions**, and **direct messages every registered player**.

This is the second and last use of direct messages, on the same rationale as match-ready: a window has opened that the player cannot otherwise discover, and missing it costs them the tournament. It is not a nudge about a pending action — the bot never sends a second one, and never chases anyone who has not checked in.

**The gap this leaves is real and is handled by a human.** With no mentions in the channel and a DM that may fail, a player who has DMs closed and is not watching the server will miss the window. So the roster view marks each entrant with two things: **checked in**, and **DM undeliverable**. An organizer can see at a glance who was never reached and chase them directly. That is the correct division — the bot does not nudge, and a person who wants to is given the information to.

## Tournament Lifecycle

Every transition is an explicit action by someone at Tournament Organizer tier or above. Nothing is on a timer, and the state machine is the guard. Referees hold none of these — they rule on matches inside a running tournament, they do not move it between states.

```
DRAFT ─► REGISTRATION_OPEN ─► REGISTRATION_CLOSED ─► CHECKIN_OPEN
                                                          │
                        ┌─────────────────────────────────┘
                        ▼
                  CHECKIN_CLOSED ─► SEEDED ─► RUNNING ─► COMPLETE
```

| Transition | Actor | Guard | Effect |
| --- | --- | --- | --- |
| `DRAFT → REGISTRATION_OPEN` | TO | Guild configured; format chosen; no other active tournament | `/join` starts working |
| `→ REGISTRATION_CLOSED` | TO | — | `/join` stops working |
| `→ CHECKIN_OPEN` | TO | — | `/checkin` starts working |
| `→ CHECKIN_CLOSED` | TO | — | Un-checked-in entrants set `NOT_CHECKED_IN` and their seeds cleared; surviving seeds renumbered from 1 in relative order; unseeded entrants appended in join order — one transaction |
| `→ SEEDED` | TO | Every active entrant has a distinct seed, contiguous from 1 | Seeds committed |

The `SEEDED` guard is an **assertion, not a gate**: normalization at check-in close already guarantees it. It stays because a violation means normalization is broken, and finding that out before a bracket is generated is much cheaper than after.

| `→ RUNNING` | TO | **Discord permission preflight passes** | Bracket generated, threads provisioned, players notified |
| `→ COMPLETE` | bot | Grand final committed | Standings posted, public archive frozen |

`CANCELLED` is reachable from any pre-`RUNNING` state at Tournament Organizer tier, and frees the guild's active slot.

**Two things happen at the start transition and only one of them can block.** Permissions are re-checked and a missing one blocks with the exact list. A song pack below 10 charts warns, names the recommended size, and proceeds — the requirement is explicit that the warning never blocks.

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

Without `MessageContent`, a message event in a guild arrives with `attachments` empty, so the bot cannot tell that a photo was posted. Both intents are toggled in the developer portal and require verification past 100 guilds — a real deployment constraint, not a formality.

**If `MessageContent` is unavailable**, the photo requirement degrades rather than breaking: `PHOTO_OBSERVED` is never emitted, the winner-selection step does not wait on it, and the thread carries a standing instruction to post the photo. The evidence still lands in the thread; the bot just cannot confirm it. This is the fallback, not the plan.

### Required permissions

Preflight computes the missing set and names it at `/setup`, again at tournament start, and once more before each round's thread burst:

View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Attach Files, Embed Links, Read Message History — scoped per channel as set out in the `/setup` diagnostic.

`Manage Channels` and `Manage Roles` are **optional**, and the only optional permissions in the design. They let `/setup` create channels and repair overwrites; withheld, setup falls back to selection plus a diagnostic and nothing else changes.

`Manage Threads` is the one that surprises people. The bot needs it to archive a thread on completion; **every tier role** needs it too, on the matches channel, because it is what lets referees see private threads at all — checked separately at `/setup`.

### The three-second rule

Discord kills an interaction that is not acknowledged within three seconds. Every handler therefore **defers first, works second** — `deferUpdate()` for a button that edits the match message in place, `deferReply({ ephemeral: true })` where the response is private, and the work (lock, validate, append, post) follows. This is not an optimization; a lock wait behind another player's action can easily exceed three seconds on its own.

### Stateless components

Button `custom_id`s encode everything the handler needs: `v1:<matchId>:<action>:<arg>`. A cuid match ID is 25 characters, so this fits Discord's 100-character limit with room for chart IDs.

**No in-memory component registry, no collectors.** A collector is a promise held in one process; the requirement is that a restart mid-Protect/Veto resumes exactly where it left off, and a promise does not survive a restart. Stateless IDs plus validation against `pendingAction` mean the buttons posted by the previous process are still fully functional after a deploy.

### Thread provisioning

Round 1 of a 32-entrant tournament creates 16 private threads at once, each with its two competitors added. Referees are not added — the tier roles' `Manage Threads` covers visibility — so a thread has exactly two members regardless of the size of the referee pool. That is still a burst against per-channel rate limits.

Provisioning runs through a **serialized queue with backoff on 429**, keyed by match ID and idempotent: a match with a `threadId` is skipped. Tournament start returns as soon as the bracket is committed; threads materialize behind it, and a crash mid-burst resumes on boot by scanning for ready matches without threads. Players are notified when their own thread exists, so nobody waits on the whole batch.

### Notifying players, and the channels

**Match-ready lands twice: a mention in the thread, and a direct message.** Being added to a private thread already notifies, but the mention makes it unmissable and the DM reaches someone who has the server muted.

**The DM is best-effort and cannot be made reliable.** Discord lets a user refuse DMs from server members; the bot cannot detect that in advance, and the send fails with `50007 Cannot send messages to this user`. That is treated as an expected outcome, not an error: logged at debug, never retried, no alert raised. **The thread mention is the notification of record** — nothing depends on the DM arriving, which is what keeps the privacy setting from becoming a support burden.

**The matches channel body carries nothing.** It hosts threads and holds the permissions that make them work — the bot's send and thread permissions, and the `Manage Threads` that gives organizers visibility. No message is ever posted in it.

That has a consequence worth stating, because a server will hit it: **#matches looks empty to everyone.** Private threads are invisible to non-members, and thread visibility requires `View Channel` on the parent, so the channel cannot be hidden from potential competitors — anyone may `/join`. A visible, permanently empty channel is the price of hosting threads somewhere.

**Results go to their own channel, one line per finished match.** Round, both players, winner, score, and a link to the match on the public bracket. Built from `toBracketMatch`, so it structurally cannot disclose anything the public bracket does not already show.

- **Byes are excluded.** A walkover with no opponent is bracket structure, not a result, and posting it would fill the channel at exactly the moment round one is busiest.
- **Forfeits and disqualifications do post**, worded as advancement rather than as a verdict.

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
| Matches | View; **deny** Send, Create Public Threads | View, Manage Threads | Full thread-capable set |
| Organizer alerts | **deny** View | View, Read History | Send, Embed Links |
| Results | View, Add Reactions; **deny** Send | — | Send, Embed Links |

`@everyone` keeps View on the matches channel deliberately: thread visibility requires it on the parent, and anyone may `/join`. The general channel is never created — every server already has one, and making a second is not a service.

**Pointing at an existing channel accepts any choice**, then computes the gap and **offers to repair it**, showing exactly which overwrites would be added before touching anything. Nothing is modified without confirmation: silently rewriting permissions on a channel a server already uses is not something a bot should do unprompted.

**Two Discord rules bound what repair can achieve.** A bot cannot grant a permission it does not itself hold, so it cannot give a tier role `Manage Threads` unless it has `Manage Threads` there; and editing overwrites for a role is subject to role hierarchy, so a tier role sitting above the bot's own highest role is untouchable. Both produce the same outcome — the gap is reported rather than fixed, naming the layer that lost the permission.

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

**Each timer fires at most once**, guaranteed by `firedAt` plus the unique `(matchId, kind)` — a match cannot accumulate duplicate start-window alerts. Timers are cancelled, not deleted, when the match leaves the relevant phase: the start-window timer on the first `SONG_STARTED`, the time-limit timer on the set result. Keeping cancelled rows means an alert that did not fire is still explicable afterwards.

**Overdue timers at boot fire immediately.** A deploy spanning an expiry produces a late alert rather than a missing one, which is the right failure for a threshold whose purpose is to get an organizer's attention.


## The Match Thread

The competitor-facing surface. Everything the rules require a player to do happens here, in a private thread holding two people and whatever the bot has posted.

### Creating the thread

**The name is `WR2 · Alice vs Bob`** — bracket side and round, then both competitors. It sorts sensibly, identifies a match at a glance in a list of sixteen, and gives an organizer the two things they scan for. Display names are truncated to fit Discord's 100-character limit, longest first so both stay legible.

**The name is fixed at creation and never changes.** Discord rate-limits thread renames to roughly two per ten minutes, so a name carrying live state would fall behind precisely when an event is busiest — the moment it would be worth having. State belongs in the thread, the bracket, and the results feed, none of which are rate-limited.

A grand final reset is a separate `Match` row and therefore a separate thread, named `GF2 · Alice vs Bob`. It gets a fresh event log, so it gets a fresh place to live.

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

A chart carries more than fits on one line of a phone: playstyle prefix, title, subtitle, artist, rating, stepartist, source pack, length, flags. Two canonical forms, used everywhere:

- **Compact** — `SX 12 · Vertex^` — for select-menu labels, inline references, and the results feed.
- **Full** — compact, plus stepartist, source pack, length and any flags — for embed fields and the Draw.

The playstyle prefix is always present and always leads, because it is the fastest way to tell a Singles chart from a Doubles one in a pack that may hold both.

### The Draw and Protect/Veto

The Draw posts as an **embed** — seven charts in full form, numbered, with the colour bar keyed to match state. It is a log message: posted once, never edited, still readable at the end of the match.

Selection uses a **string select menu**, not seven buttons. Discord allows five buttons per row, so seven charts means two ragged rows of labels capped at eighty characters — no room for rating, stepartist or flags, exactly the information that should inform a Veto. A select menu holds twenty-five options, each with a label and a description line, so the metadata sits with the choice rather than being cross-referenced by eye against the embed above. It is also one tap target rather than seven, which matters on the surface most of this happens on.

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

**The select menu lives on the state message; the response is ephemeral.** The component is visible to both players, but a component interaction is private to whoever used it: the opponent sees no selection, and nothing about the choice is written into the message. One tap, no extra round trip.

**The label has to say so plainly.** A picker sitting in a shared message will make people hesitate whatever the underlying behaviour, and a player who hesitates over whether their pick is about to be broadcast is a player who has been given a worse game. The prompt states that the choice is private and revealed only once both have chosen.

**The state message shows who has acted, never what they picked** — the projection rule from Public Projections and Hidden State, rendered. It edits as each pick lands, which reposts it if a photo has arrived since.

**Selections are final.** A second interaction from a player who has already chosen is refused ephemerally, saying what they picked so they are not left guessing. This is validation against `PendingAction` like everything else: once their choice is in the log, they are no longer an eligible actor for that round.

**The reveal is a log message**, posted once both picks exist: both selections, the rule applied — same chart plays, different charts means the unselected one plays — and the chart that results. Permanent, because by then it is history and the whole point of the mechanism is that it can be audited afterwards.

### Ending the match

The result summary is a log message and the last thing the bot posts: songs in play order with both EX% values and the winner of each, tiebreak rounds if any, and the final score. The thread archives immediately afterward.

It is rendered from the same projection as the public match view, so the thread and the web page cannot disagree about what happened.

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
| What tier does this user hold here? | Highest of the three `Guild.*RoleId` roles they hold |
| May they rule on a match? | Tier ≥ Referee |
| May they run a tournament? | Tier ≥ Tournament Organizer |
| May they reconfigure the bot here? | Tier = Server Administrator |
| Is this user a bot administrator? | Config allowlist ∪ `Admin` table |
| May this user act in match M? | Is one of the two players, or holds Referee tier |
| May a referee override this song? | Not frozen — see Bracket Immutability |

Config admins are re-applied additively at boot, which is the lockout recovery path.

Public bracket and match history need **no authentication** — sign-in only adds a personalized dashboard.

**Sessions are a signed cookie carrying the Discord user ID**, and nothing else. There is no session table.

The reasoning shifted once tiers moved to Discord roles: authorization now reads tier from the gateway member cache, so a request costs **zero database queries** to authorize. A session table would therefore *add* a query rather than replace one, plus a table and an expiry sweep, to serve a handful of privileged users per server.

Revocation is already instant without it — removing someone's role locks them out on their next click, because nothing about their authority is stored in the cookie. Rotating `SESSION_SECRET` is a global logout. The one capability given up is killing a single session while leaving others alive, which is worth a table only if it becomes a real need rather than a hypothetical one; the authorization path does not change either way, so adopting one later is cheap.

**JWTs with embedded tiers were rejected outright.** Baking authority into a bearer token means a demoted referee keeps ruling until it expires, and the fix is a denylist — a session table with extra steps and worse ergonomics.

**The override boundary is one predicate.** "A referee may act here" is `!state.songs[i].result` for a song, and `state.songs.length === 0` for a Protect/Veto reset. Both transports call the same function, so an override that is illegal in the web UI is illegal from an alert-channel button.

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

Desktop-first, best-effort accessibility, and used by all three tiers — what a person sees is filtered by `tierOf`, not by which console they opened.

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

**Two ways to move someone, one underlying operation.** Dragging handles small adjustments; typing a seed number directly handles moving someone from 40 to 2, where dragging against a scrolling list is miserable. Both submit the same reorder, which writes the whole normalized order in one statement — which is what the deferred unique constraint exists for.

Unseeded entrants sit in a separate group below the ordered list, in join order, showing where they would land if seeding were committed as-is.

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

**A draw records the chart's metadata, not just its ID.** `DRAW_MADE` and `TIEBREAK_DRAWN` carry a `ChartSnapshot` per chart — the chart ID plus everything needed to render it in full form: title, subtitle, artist, playstyle, difficulty slot, rating, stepartist, source pack, length, flags.

This exists because charts stay editable while a tournament runs. A wrong rating or a mistyped title discovered during play should be fixable, and a `Chart` row is referenced by ID from every event that touched it — so without a snapshot, correcting a row silently rewrites how every past match renders. Snapshotting separates the two concerns cleanly:

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

**Search is one field across many.** It matches title, `titleTranslit`, subtitle, artist, source pack and stepartist together — a player searching *vertex sanxion* is combining a title and a stepartist and should get the chart. Matching normalises case, diacritics and punctuation, then requires every typed token to appear somewhere in the chart's combined text, in any order. That covers partial and out-of-order words without the cost or the false positives of true edit-distance matching; typo tolerance can come later if anyone misses it.

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

**Format details that will bite.** `.sm` charts are `#NOTES` blocks with colon-separated fields; `.ssc` uses `#NOTEDATA` sections with named tags, and the two coexist in the same pack — often the same song. Prefer `.ssc` where both exist for a song, since it is the newer authored form. Song length is derived from chart timing (last note against the BPM and stop map) rather than the audio file, so packs whose audio is absent or oddly encoded still yield an estimate.

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
