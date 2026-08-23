# ITG Tournament Bot

## Overview

The In The Groove (ITG) Tournament Bot is a Discord bot that automates the running of ITG tournaments. Tournament organizers (TOs) can create tournaments, seed players, and start or officiate matches. Competitors run `/join` to enter a tournament created by an admin. Once the tournament begins, each pair of competitors is placed in a private Discord thread with their opponent. The bot walks them through song draws, Protect/Veto action order, and match reporting. After all matches are completed a winner is crowned.

The bot is paired with a web application: a **TO interface** for running the event and a **public bracket** for competitors and spectators.

## Scope

The system has three surfaces:

1. **Discord bot** — the competitor-facing surface. Registration, match threads, Protect/Veto, score reporting.
2. **TO web UI** — the organizer-facing surface. Tournament setup, seeding, song packs, live bracket, overrides.
3. **Public web view** — a read-only bracket and match history anyone can browse.

### Terminology

| Term | Meaning |
| --- | --- |
| **Song pack** | Every chart available in the tournament |
| **Draw** | The 7 charts drawn for a single match, which Protect/Veto operates on |
| **Set** | The songs actually played in a match — 3 to 5, plus any tiebreak songs |
| **Decider** | The one chart left after Protect/Veto, played as the 5th song if the set gets that far |
| **Chart** | One difficulty of one song. A song pack holds charts, not songs |
| **Source pack** | A StepMania `.zip` or folder a song pack can be built from |

## Match Flow

### Set format

Every match in the tournament is **best of 5**. A player wins the set by reaching **3 points**.

**Scoring model.** Winning a song awards **1 point**. An exact tie awards **0 points to both players** — a tied song consumes a song slot without advancing either player. The set ends the moment a player reaches 3, so a match runs anywhere from 3 songs to 5, plus any tiebreak songs.

### How the bot draws charts

One rule governs **every** draw the bot makes — the initial Draw and every tiebreak draw alike:

1. Draw uniformly at random from the **eligible** charts in the song pack.
2. If more charts are needed than remain eligible, draw all the remaining eligible charts, **re-shuffle** (making every chart in the pack eligible again), and draw the rest.

What counts as eligible differs by draw type, and is stated where each draw is defined.

Exhaustion is therefore normal behaviour rather than an error. A pack of 4 charts still produces a 7-chart Draw — it simply contains duplicates.

### 1. The Draw

The bot draws **7 charts** from the tournament's global song pack. This set of 7 is the match's **Draw** — the working set that Protect/Veto operates on.

- **Eligibility:** every chart in the song pack. There are **no constraints** — no difficulty spread, no duplicate-song exclusion, no avoidance of charts a player has already seen.
- A pack of 7 or more always yields 7 distinct charts. A smaller pack triggers the reshuffle above, so the Draw can contain the same chart more than once.

### 2. Protect / Veto

The higher seed chooses whether to take the **first or second Protect**. The two players then act in **ABBAAB** order:

| # | Player | Action |
| --- | --- | --- |
| 1 | A | Protect |
| 2 | B | Protect |
| 3 | B | Veto |
| 4 | A | Veto |
| 5 | A | Protect |
| 6 | B | Protect |

Where A is whichever player took the first Protect.

Outcome: **4 protected charts** (eligible to be played), **2 vetoed charts** (discarded), and **1 chart remaining**, which becomes the **Decider** — the potential 5th song of the set.

Not all five are necessarily played: a set ending 3-0 plays three songs. The four protects define the songs available, not a fixed running order.

### 3. Play order

The four protected charts have a canonical **protect order** — the sequence in which they were protected during ABBAAB (A's first, B's first, A's second, B's second).

- The **first song of the set is the first Protect**.
- After each song, the **loser of that song plays the next**, taking the first of these that is available:
  1. their **own earliest unplayed Protect** — a player's two protects are consumed in the order they were protected;
  2. the **Decider**, if it has not been played;
  3. **whatever chart remains** — necessarily the opponent's Protect.
- If a song ends in a **tie** there is no loser. The bot plays the **next unplayed chart in protect order**, falling through to the Decider if all four protects have been played.

**No player chooses the next song.** Every clause resolves to exactly one chart, so play order is fully determined from the moment Protect/Veto ends. The loser of a song influences what comes next — it is their protect that gets played — but they make no selection, and the bot advances the set on its own until a tiebreak is needed or a player reaches 3.

### 4. Scoring a song

After every song, each player reports **both**:

- the **EX% they received**, submitted through a **modal**. The bot posts a *Submit score* button; clicking it opens a Discord modal with an EX% field, which is validated on submit.
- a **photo of their result screen**, posted as a normal message in the match thread.

Both are always required — this is not a dispute-only step. Each player submits their own; neither can report for the other.

**EX% format.** Two decimal places, matching how ITG displays percentages on the result screen — e.g. `92.45`. Valid range is `0.00` to `100.00`, enforced by the modal, which rejects malformed input before it reaches the thread. Exact ties at this precision are uncommon but entirely realistic, which is why the tiebreak procedure is a live path rather than a formality.

The bot then displays both entered scores, and **both players select the song winner**. The two selections must agree before the match proceeds to the next song.

- A song that ends in an exact tie awards **no points to either player**.
- If the two winner selections **disagree**, the match is **immediately escalated to a TO** for a ruling. There is no retry loop; the posted photos and EX% values are the evidence the TO rules on.

**Photos are never retained by the application.** They live solely as Discord attachments in the match thread. Because threads are archived and **never deleted**, those photos remain available indefinitely for reference after a disputed ruling. Only the EX% values persist in the application's own system of record.

### 5. Set tiebreak procedure

If all songs in the set have been played and **neither player has reached 3 points**, the tiebreak procedure begins:

1. The bot draws **3 charts** and posts them in the thread with a button for each.
2. Each competitor **privately selects** one (a prisoner's dilemma). A click is confirmed **ephemerally**, so a player sees only their own choice. The thread shows that a player *has* chosen without revealing what.
3. Once both have chosen, the bot **reveals both selections** and resolves:
   - both picked the **same** chart → that chart is played;
   - they picked **different** charts → the **unselected** chart is played.
4. The song is scored normally: the winner earns **1 point**, a tie awards nothing.
5. **Repeat from step 1 until a player reaches 3 points.**

Selections cannot be changed once submitted. As everywhere else, a player who never chooses simply stalls the match — there is no timer and the bot takes no action, so a TO resolves it (see Automation Boundary).

Tiebreak songs are ordinary scoring songs — the set is always decided by a player reaching 3, never by winning a tiebreak outright. A set that reached the tiebreak at 2-1 needs one more decisive song; a set that arrived at 0-0 through five tied songs needs three.

**Eligibility.** A tiebreak draw excludes **every chart already drawn in this match, regardless of status** — protected, played, vetoed, or previously drawn for an earlier tiebreak round. Everything else in the song pack is eligible, and the general reshuffle rule applies when that runs out.

### 6. Set result

- The final winner of the set must be **confirmed by both players**.
- **No-shows and disqualifications are never automated.** If a player is absent or unresponsive, the bot alerts the TO channel; a **TO** decides the outcome and applies it.
- If a competitor **leaves the Discord server** mid-tournament, the bot alerts the TO channel. A TO applies the **disqualification**.
- A **forfeit** is always an **ordinary loss**: the opponent advances and the forfeiting player drops to the losers bracket. A second such loss eliminates them, exactly as a played loss would.
- A **disqualification** asks the TO to choose its scope:
  - **this match only** — behaves exactly like a forfeit, dropping the player to the losers bracket; or
  - **withdraw from the tournament** — the player is removed from **both brackets** at once and every remaining opponent receives a walkover automatically.

  The second option exists so a player who has left the server, or is otherwise gone for good, can be handled in a single TO action rather than being disqualified again in the losers bracket.

## Song Packs

- Each tournament has **one global song pack**.
- Song packs are **configurable per tournament**.
- Charts are **never removed from the song pack once played**. The same song may be drawn in multiple matches, including within the same round.

### Chart metadata

A song pack entry is a **chart**, not a song — the same song may appear as several charts. Each entry carries:

| Field | Notes |
| --- | --- |
| Title | Transliterated field takes priority: `titleTranslit \|\| title` |
| Subtitle | Transliterated field takes priority: `subtitleTranslit \|\| subtitle` |
| Artist | Transliterated field takes priority: `artistTranslit \|\| artist` |
| Chart type | Single or double |
| Difficulty slot | Novice / Easy / Medium / Hard / Expert |
| Playstyle prefix | Derived display code, see below |
| Difficulty rating | Block rating |
| Stepartist | Displayed when available |
| Source pack | Which StepMania pack the chart came from |
| Song length | Also feeds the duration estimate |
| Flags | Optional list. Currently the only flag is **`noCmod`** — players may not use a C-Mod speed modifier on that chart |

**Playstyle prefix.** Whenever chart info is displayed, it carries a two-letter code combining playstyle and difficulty slot — `SX` (Single Expert), `DX` (Double Expert), `SH`/`DH` (Hard), and so on across `N`/`E`/`M`/`H`/`X`.

A tournament will normally use one playstyle or the other, but **nothing prevents a TO from including both Singles and Doubles charts in the same song pack.**

Chart flags surface to players at three points:

1. **On the chart in the Draw**, so the restriction informs Protect/Veto strategy.
2. **Called out in the thread** when that song comes up to be played.
3. **At score verification** — when players are confirming scores and selecting a winner for a `noCmod` chart, the bot prompts them to check that both players used the correct settings.

**Enforcement.** The bot cannot observe what modifiers a player used, so flags are enforced socially rather than technically. If a player completed the song with the wrong setting:

- either competitor may press **report a settings problem**, a button the bot shows alongside the settings prompt at score verification. It escalates to the TO alert channel with the match, song, chart, flag, reporter, and both submitted EX% values attached. Reporting outside the bot — telling a TO directly — remains available and reaches the same ruling.
- the TO is instructed to **grant the song win to the player who played with the correct settings**.

The report button is available only **until the song commits**. Once both players have agreed a winner the result is frozen (see Bracket Immutability), and a violation noticed after that point cannot be corrected.

**If both players used the wrong setting** there is no correct-settings player, so the bot notifies the TO and offers a choice:

- **select a winner** — appropriate when time is a constraint, since both players held the same illegal advantage and the comparison is still between equals; or
- **void the song** — no points to either player and the set moves on, handled exactly like a tied song (next chart in protect order).

In every case the TO applies the outcome as a forced result, which is permitted because the song has not yet been committed (see Bracket Immutability).

### Song pack size

There is **no hard minimum**. A TO may start a tournament with a song pack of any size — the general reshuffle rule (see **How the bot draws charts**) absorbs any shortfall, including song packs smaller than the 7 charts a Draw requires.

Small song packs produce visibly repetitive behaviour: charts recur across matches, and below 7 a single Draw can contain the same chart more than once. This is permitted on the assumption a TO doing it is doing it deliberately.

The bot **always warns** when the song pack is below the recommended minimum of **10 charts** — 7 for a Draw plus 3 for one tiebreak round with no repeats — naming the recommended size and what the TO should expect. The warning never blocks the start.

### Building a song pack

TOs can populate a song pack by:

- **Importing a source pack** — a StepMania `.zip` or folder. The source pack is **parsed entirely client-side**; the simfiles themselves are never uploaded. The browser produces a JSON chart list which is what gets sent to the server.
- **Bulk paste or file import** of a chart list.
- **Adding charts individually** through the web UI.
- **Copying a song pack from a previous tournament** on the same server.

## Configurability

A TO configures a tournament by **choosing its match format** and **setting timer durations**. Nothing inside a format is adjustable — set length, Draw size, and action order are properties of the format itself, not knobs.

The match format is a **pluggable ruleset** rather than hardcoded logic, so further formats — Bo3, prisoner's-dilemma-only, fixed song list, and others — can be added without reworking the system. **Only the Bo5 ruleset specified in this document ships initially**, so the format picker offers a single option at launch; it exists so that adding the second format requires no change to the TO's workflow.

## Automation Boundary

**The only outcomes the bot commits on its own are ones both players have signed off on** — an agreed song winner, an agreed set result. Everything else is a TO decision.

Specifically, the bot **never**:

- forfeits a match on its own,
- disqualifies a player on its own,
- picks a Protect or Veto on a player's behalf, or
- advances the bracket **on the basis of a match outcome** without either mutual player agreement or a TO ruling.

**Byes are exempt.** A player receiving a round 1 bye has no opponent to be matched against, so there is no match outcome to agree on and nothing for a TO to rule. The bot advances them as a matter of bracket structure.

Forfeits and disqualifications exist as **TO-initiated** actions (`/forfeit`, `/dq`, and the web UI) — the boundary is that the bot never reaches those outcomes by itself, no matter how long a player is silent.

The bot also **does not nudge players**. A player waiting on an unresponsive opponent handles that themselves. The bot's only role in a stalled match is to **alert TOs** so an organizer can move it along.

## Timers

Timers are **alert thresholds, not enforcement**. Each is TO-configurable, and expiry posts to the TO alert channel without changing match state.

- **Match start window** — default **10 minutes**. Players are expected to start their match within this window; if they have not, TOs are alerted.
- **Overall match time limit** — default **25 minutes**, matching the duration-estimate allocation. Exceeding it alerts TOs so the event stays on schedule.

Score reporting is deliberately **not** on a timer.

## Bracket Immutability

Once a tournament has started:

- **Seeding and matchups are locked.** Entrants cannot be added or removed.
- A player who wants out is **disqualified by a TO**, who chooses whether the disqualification covers only the current match or withdraws them from the tournament entirely (see Match Flow, Set result). Affected opponents are advanced accordingly.

**Results freeze as they commit, one song at a time.** The boundary is:

| State | TO can intervene? |
| --- | --- |
| Protect/Veto, before song 1 is played | Yes — the sequence can be reset |
| Song currently in progress | Yes — correct a score, force a winner on an escalation |
| Song whose winner both players have agreed | **No** — frozen |
| Protect/Veto, once song 1 has been played | **No** — frozen |
| Set whose result both players have confirmed | **No** — frozen |

A committed song result is permanent, whether it was reached by mutual player agreement or by a TO ruling. Nothing rewinds.

## Roles

Competitors are identified by their **Discord account only**. There is no separate player profile, tag, or external profile link.

**Identity vs. display.** The **Discord user ID** is the identity — it is unique, never changes, and is what every roster entry, match record, and history lookup is keyed on. The **display name as shown in the server** is captured as a **snapshot at registration** and stored with that tournament.

A player who later renames themselves keeps all their history, because the ID never moved. Past brackets continue to show the name they competed under; a new tournament picks up their new name at registration.

### Granted roles

These are explicitly assigned and confer permissions. The first three are **server-scoped tiers, granted by assigning a Discord role**; the fourth is deployment-scoped and unrelated to Discord roles.

| Role | Scope | Capabilities |
| --- | --- | --- |
| Referee | One Discord server | Rule on matches to unblock them — award or void a song, force a result on an escalation, reset Protect/Veto before song 1, forfeit a match, disqualify a player at either scope. All within the limits in Bracket Immutability. **Cannot create, start, or close a tournament** |
| Tournament Organizer (TO) | One Discord server | Everything a Referee can do, plus create and configure tournaments, manage song packs, open and close registration and check-in, seed the bracket, start and cancel a tournament |
| Server Administrator | One Discord server | Everything a TO can do, plus reconfigure the bot for that server — the channels and roles chosen during `/setup` |
| Bot Administrator | The whole deployment | View every Discord server the bot has been added to, and the tournaments and brackets belonging to each |

**The tiers are cumulative**: each holds every capability of the one below it.

**Referee exists so refereeing can be delegated.** Running an event needs more hands than running the tournament does, and someone trusted to unblock a stalled match need not be trusted to cancel the tournament.

**A server may collapse the tiers.** Pointing two or three of the tier slots at the same Discord role is a supported configuration, for servers that want the same people involved at every level.

**"Server Administrator" and "Bot Administrator" are unrelated.** The first is a per-server tier; the second is a deployment-wide role held by whoever operates the bot. Neither implies the other.

### Granting the server tiers

- Each tier is bound to a **Discord role**, chosen during `/setup`. Membership of that role *is* the grant — there is no separate list maintained inside the application.
- Adding or removing someone is therefore done in Discord, using its own member and role management.
- The bot **records every grant and revocation** of a tier role in its own audit log, so there is a timestamped, application-side history independent of Discord's.
- Because anyone with Discord's Manage Roles permission can assign a tier role, including to themselves, **tournament start warns if any entrant also holds a tier role**, naming them. The warning does not block the start.

### Granting the Bot Administrator role

- A **configuration allowlist** of Discord user IDs is applied at every boot. It is **additive** — the bot ensures those users are administrators and never removes anyone.
- Existing administrators can **promote others through the web UI**. Promotions are stored in the database, survive restarts and redeploys, and are **logged by the application**.
- The config allowlist is therefore the **lockout recovery path**: if the database is lost or every administrator is removed, editing the config and redeploying restores access.

### Competitor is not a role

**Competitor is derived state, not a grant.** Any member of the Discord server may run `/join` while registration is open; from that point they are on the roster. Their permissions are per-match and follow from being one of the two players in a given thread — there is nothing to assign and nothing to revoke when the tournament ends.

Note that the three server tiers are **bound to** Discord roles but are not the same thing as them: the bot cares only about membership of the specific roles named during `/setup`, and ignores every other role and every native Discord permission. Bot Administrator is not a Discord role at all.

## Tournament Lifecycle

### Bracket format

- **Double elimination only.**
- **Byes.** The bracket is padded to the next power of two and the **highest seeds receive round 1 byes**.
- **Losers bracket routing.** Losers drop into the losers bracket using the **standard predetermined stagger**: the order of players dropping out of a winners round is transformed (reversed or rotated) relative to the losers-bracket positions receiving them, so players from the same region of the winners bracket are separated.

  This pattern is **fixed at bracket generation** from bracket positions alone and **never reacts to results**. It is therefore seed-neutral — every player's path difficulty follows from their seed, exactly as seeding intended — while delaying rematches as long as the structure allows. A grand final rematch between two players who already met remains possible and is expected.

- **Grand final bracket reset.** The finalist coming from the losers bracket must win **two sets** to take the tournament; the winners-bracket finalist needs only one. If the losers-side finalist wins the first set, a second set is played as a **completely fresh match** — new 7-chart Draw, full ABBAAB Protect/Veto. Seed advantage follows **original seeding**, so the winners-bracket finalist keeps the first-or-second Protect choice in both sets.

Individual match rules are in **Match Flow**.

### Registration

- Competitors register with `/join`.
- The registration window is explicitly opened and closed by the TO. `/join` only works while the window is open.
- **No roster size cap.**
- After registration closes there is a **separate check-in window**. Registered players must confirm attendance; no-shows are dropped from the roster before seeding.

### Duration estimation

This feature exists specifically to support **remote tournaments**, where every player has access to their own machine. There are no shared stations and no queueing for hardware.

- The bot estimates total tournament duration from a TO-configured per-match time allocation, defaulting to **25 minutes per match**.
- Because every match in a round can run simultaneously, the estimate is driven by **bracket depth, not match count**.
- The bot walks the generated bracket and counts the rounds that must happen **sequentially** — winners rounds, losers rounds as they interleave, and the grand final — then multiplies by the per-match allocation.
- The estimate accounts for a possible **grand final reset** as an additional round.

### Seeding

- Seeds are entered **manually by the TO** through the web UI.
- The bracket is generated from those seeds once seeding is committed.

### Starting the tournament

Every transition is an explicit TO action; nothing in the lifecycle is on a timer.

1. TO **closes registration**.
2. TO **opens check-in**. Check-in has **no duration** — it stays open until closed.
3. TO **closes check-in**. Players who did not confirm are dropped from the roster.
4. TO **enters seeds** in the web UI and commits them.
5. TO **starts the tournament**. At this moment the bot:
   - re-checks that all required Discord permissions are still granted, **blocking the start** if any are missing;
   - warns if the song pack is below the recommended minimum, **without** blocking;
   - generates the bracket, creates the round 1 match threads, and notifies players.

## Discord Surface

- The bot uses **slash commands with interactive buttons** throughout. There are no prefix (`!`) commands. Protect/Veto actions, winner selection, and tiebreak song selection are all button-driven.
- Matches take place in **threads under a single matches channel**, not in dedicated channels.
- A match thread is **private to the two competitors and anyone holding a server tier role**. Spectators do not have read access.
- On creating a thread the bot adds **only the two competitors** as members. Organizers see match threads through Discord's **Manage Threads** permission on the matches channel, which every tier role must hold — so a thread has two members however large the referee pool is, and someone granted a tier mid-tournament can immediately read every open match.
- Each player may only submit **their own** score and **their own** Protect/Veto actions.
- On match completion the bot **posts a result summary** — songs played, per-song scores and winners, any tiebreak songs, and the final result — as the last message in the thread.
- The thread is then **auto-archived immediately**.
- **Threads are never deleted.** They stay archived in Discord indefinitely, which keeps every posted result-screen photo available after the event.

The web backend remains the system of record for structured data — every chart drawn, protected, vetoed and played, every EX% and every song winner. The archived threads are the durable home for the **photos**, which the application itself never stores.

**Accepted risk.** "Never deleted" is a rule the bot follows, not one it can enforce — anyone with Manage Threads can delete a thread, and the photos in it are then gone for good. This is accepted: photo retention is best-effort and depends on Discord. No structured data is affected, since EX% values, song winners, and the bracket all live in the backend.

### Command inventory

| Command | Who | Effect |
| --- | --- | --- |
| `/join` | Competitor | Enter the open tournament. Works only while the registration window is open |
| `/checkin` | Competitor | Confirm attendance during the check-in window |
| `/setup` | Server Administrator, or anyone with Discord's Manage Guild | Server setup — point the bot at the existing matches channel, TO alert channel, and the Discord role for each tier. Re-runnable |
| `/setup status` | Server Administrator | Re-run the configuration and permission diagnostic without changing anything |
| `/dq` | Referee | Disqualify a player, choosing whether it applies to this match only or withdraws them from the tournament |
| `/forfeit` | Referee | Award a match to a player whose opponent is absent or unresponsive |

`/setup` accepts Manage Guild as well as the Server Administrator tier because the tier is *configured by* `/setup` — a freshly-invited server has no administrator role yet, and Manage Guild remains the recovery path if the roles are later deleted or misconfigured.

Match play itself uses **buttons, not commands** — Protect, Veto, score submission, winner selection, and tiebreak song selection are all button interactions inside the match thread. Where a button needs a typed value, it opens a **modal** rather than asking for a chat message; EX% entry is the only such case.

The one thing players post as an ordinary message is the **result-screen photo**.

### TO rulings

TOs can rule from either surface:

- **From the TO alert channel.** Escalation and timer alerts carry action buttons for the common rulings — award the song to either player, void the song, open the match in the web UI.
- **From slash commands**, for anything the alert buttons do not cover.
- **From the web UI**, which retains the full set of override capabilities.

**Authorization.** Button interactions and organizer slash commands are authorized by resolving the acting user's **tier** — the highest of the three configured Discord roles they hold — and comparing it against what the action requires. Every ruling in the alert channel requires **Referee**; nothing there requires more. A user below the required tier receives an ephemeral rejection visible only to them.

Only the specific roles named during `/setup` are consulted. No other Discord role and no native Discord permission grants authority over a tournament, so a server administrator who has not been given a tier role cannot rule on a match.

Buttons remain *visible* to anyone who can read the channel; enforcement happens on the click. The TO alert channel is expected to be permission-restricted in Discord as a first gate.

## Notifications

- The bot **pings both players when a new match is ready** — that is, when their next-round opponent is determined and the thread has been created.
- A separate **TO alert channel** receives escalations, timer alerts, and disputes.

The bot does **not** ping a player to prompt a pending action (see Automation Boundary).

Direct messages are not used.

## Server Setup

- **`/setup`** runs server setup and can be re-run at any time. It does **not** provision channels or roles itself — it asks the administrator to create them, then has them point the bot at the existing **matches channel**, **TO alert channel**, and a Discord role for each of the three tiers. The same role may be given for more than one tier.
- A **guided first-run wizard** in the web UI walks a new server through server configuration, building a song pack, and creating its first tournament.
- **Setup accepts any selection.** No role or channel picker is filtered and no choice is rejected for lacking a permission — an administrator does not necessarily know a role's permissions, and refusing the input would prevent them recording the decision before they have been told what to fix.
- **The bot reports exactly what is missing**, for each channel and each tier role, and says *where* the permission was lost — absent from the role itself, or denied by a channel overwrite — because the fix differs. The report offers a one-click re-check and is available any time via `/setup status`.
- **Tournament start is the blocking gate.** Permissions are re-checked there and the start is blocked if anything required is missing or has since been removed.

## Authentication

- TOs and bot administrators sign in to the web UI with **Discord OAuth**.
- Organizer access is **granted by Discord role membership**, using the roles bound to each tier during `/setup`. Signing in is never required to hold a tier: a referee can work entirely from Discord, since alert-channel buttons and slash commands are a complete workflow.
- Only `identify` scope is requested. Which servers a signed-in user may act in is resolved from their tier role membership, not from the OAuth token.

## TO Web UI

- Tournament setup and registration management — create a tournament, **choose its match format**, set timer durations and the per-match time allocation, open and close the registration and check-in windows, manage the roster.
- Song pack management — build and edit the song pack for each tournament.
- **Manual seeding** interface.
- **Live bracket view** — real-time match states, current song, and running scores.
- **Match intervention / overrides** — see Bracket Immutability for the boundary. A TO may act on the **song currently in progress**, reset a Protect/Veto **before song 1 has been played**, force a result on an escalated song, disqualify a player, and apply forfeits.

## Public Web View

Competitors and spectators have access to a public bracket page. Clicking a match reveals:

- the songs drawn for that match
- the full Protect/Veto action sequence
- who won each song, and the scores each player entered
- the songs drawn and played for any tiebreak rounds
- the final match result

The public bracket is **fully mobile-usable** — spectators are assumed to be on phones. The TO web UI is **desktop-first**; organizers are assumed to have a laptop at the event.

The public bracket updates by **real-time push** — bracket state and in-progress match state change without the viewer refreshing.

## Results and History

- On completion the bot posts **final standings** in Discord — the winner and the full placement order.
- The **public results page persists** after the event as a permanent archive.
- **Match history is public.** Any visitor can browse any player's past matches and scores on that server without signing in.
- Players may sign in with **Discord OAuth** to get a personalized dashboard, but sign-in is never required to view history.

## State, Persistence, and Multi-Tenancy

- **Full state is persisted.** A restart mid-Protect/Veto or mid-set resumes exactly where it left off.
- A single bot instance serves **multiple Discord servers**, each with independent tournaments and song packs.
- **One active tournament per Discord server.** A new tournament cannot start until the current one finishes.
- **Historical results are retained** and remain queryable after an event ends.
- History is **scoped to the Discord server** it belongs to.
- The bot administrator can see which servers the bot has been added to and view the tournaments and brackets belonging to each.

## Non-Functional Requirements

- **Scale.** Target local-event scale initially — on the order of tens of entrants per tournament — but the design must accommodate growth to larger fields and more servers without rearchitecting.
- **Extensibility.** Match formats are pluggable (see Configurability).
- **Recoverability.** No tournament state is lost across a bot restart (see State, Persistence, and Multi-Tenancy).
- **Accessibility.** The **public bracket targets WCAG 2.1 AA** — sufficient contrast, full keyboard operability, visible focus indicators, semantic markup and labelling for screen readers, and real-time bracket updates announced rather than silently swapped in. It faces a wide, unknown audience, so it carries the formal bar.

  The **TO web UI is best-effort**: its audience is small and known, and it is desktop-first by design. Accessibility problems there should still be fixed when found, but no conformance level is required.

## Non-Goals

Explicitly out of scope:

- **Automatic score capture.** Scores are always self-reported; no GrooveStats or cabinet integration is planned.
- **Team tournaments.** Only 1v1 brackets. (Doubles *charts* are supported — doubles is a chart type, not a team format.)
- **Streaming and casting tools.** No overlays, commentator views, or broadcast integrations.
- **Payments, prizes, or entry fees.** The system handles no money.
