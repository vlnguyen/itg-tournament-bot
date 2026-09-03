# ITG Tournament Bot

## Overview

The In The Groove (ITG) Tournament Bot is a Discord bot that automates the running of ITG tournaments. **Tournament organizers** create and configure tournaments, seed players, and start them. **Referees** rule on matches that stall or are disputed. Competitors run `/join` to enter. Once the tournament begins, each pair of competitors is placed in a private Discord thread with their opponent. The bot walks them through song draws, Protect/Veto action order, and match reporting. After all matches are completed a winner is crowned.

The bot is paired with a web application: an **organizer interface** for running the event and a **public bracket** for competitors and spectators.

## Scope

The system has three surfaces:

1. **Discord bot** — the competitor-facing surface. Registration, match threads, Protect/Veto, score reporting.
2. **Organizer web UI** — the organizer-facing surface. Tournament setup, seeding, song packs, live bracket, overrides.
3. **Public web view** — a read-only bracket and match history anyone can browse.

### Terminology

| Term | Meaning |
| --- | --- |
| **Song pack** | Every chart available in the tournament |
| **Draw** | The 7 charts drawn for a single match (Bo5; 5 for Bo3), which Protect/Veto operates on |
| **Song Pool** | Hubert's formats' equivalent of a Draw — every song in the pack the TO has labeled for that format, fixed rather than drawn — see Configurability |
| **Set** | The songs actually played in a match — the number varies by format, plus any tiebreak songs |
| **Decider** | The one chart left after Bo3/Bo5's Protect/Veto, played as the last song if the set gets that far |
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
- If the two winner selections **disagree**, the match is **immediately escalated** for a ruling by anyone at **Referee** tier or above. There is no retry loop; the posted photos and EX% values are the evidence the referee rules on.

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

Selections cannot be changed once submitted. As everywhere else, a player who never chooses simply stalls the match — there is no timer and the bot takes no action, so a referee resolves it (see Automation Boundary).

Tiebreak songs are ordinary scoring songs — the set is always decided by a player reaching 3, never by winning a tiebreak outright. A set that reached the tiebreak at 2-1 needs one more decisive song; a set that arrived at 0-0 through five tied songs needs three.

**Eligibility.** A tiebreak draw excludes **every chart already drawn in this match, regardless of status** — protected, played, vetoed, or previously drawn for an earlier tiebreak round. Everything else in the song pack is eligible, and the general reshuffle rule applies when that runs out.

### 6. Set result

- **The set is decided automatically once a win condition is reached — no separate confirmation step.** A player who has agreed on every song's outcome has, by construction, already agreed on the set: the score is nothing but the tally of already-agreed songs, so once the win condition itself resolves there is nothing left to independently confirm.
- **The thread and the match page record which win condition decided it:** reaching the target point count outright, most points once the forced Tiebreaker/Decider song was played without reaching the target, or — Hubert's formats only — higher average EX% once points stayed level through that song too. The ordinary case (reaching the target outright) isn't called out; the other two are, since a reader can't infer them from the score alone.
- A referee may still rule the set directly at any point, exactly as before.
- **No-shows and disqualifications are never automated.** If a player is absent or unresponsive, the bot alerts the organizer alert channel; a **referee** decides the outcome and applies it.
- If a competitor **leaves the Discord server** mid-tournament, the bot alerts the organizer alert channel. A **referee** applies the **disqualification**.
- A **disqualification** asks the referee to choose its scope:
  - **this match only** — an **ordinary loss**: the opponent advances and the disqualified player drops to the losers bracket, exactly as a played loss would. A second such loss eliminates them. This is also how a plain **forfeit** — a no-show, or a player conceding — is applied; there is no separate action for it, since the outcome is identical either way; or
  - **withdraw from the tournament** — the player is removed from **both brackets** at once and every remaining opponent receives a walkover automatically.

  The second option exists so a player who has left the server, or is otherwise gone for good, can be handled in a single referee action rather than being disqualified again in the losers bracket.

## Song Packs

- Each tournament has **one global song pack**.
- Song packs are **configurable per tournament**.
- Charts are **never removed from the song pack once played**. The same song may be drawn in multiple matches, including within the same round.

### Chart metadata

A song pack entry is a **chart**, not a song — the same song may appear as several charts. Each entry carries:

| Field | Notes |
| --- | --- |
| Title | Both forms stored: `title` and `titleTranslit`. Display resolves `titleTranslit \|\| title` |
| Subtitle | Both forms stored. Display resolves `subtitleTranslit \|\| subtitle` |
| Artist | Both forms stored. Display resolves `artistTranslit \|\| artist` |
| Chart type | Single or double |
| Difficulty | The named slot: Novice / Easy / Medium / Hard / Expert |
| Playstyle prefix | Derived display code, see below |
| Meter | The numeric block rating |
| Stepartist | From `#CREDIT`. Displayed when available |
| Description | From `#DESCRIPTION`. A free-text chart label, often a variant name. Displayed when available; **not searchable** |
| Source pack | Which StepMania pack the chart came from |
| Flags | Optional list. Currently the only flag is **`noCmod`** — players may not use a C-Mod speed modifier on that chart |

**Both text forms are kept rather than resolved away at import.** The original survives, so a chart search matches whichever form a player types — the Japanese title or its romanisation — and the display precedence stays a rendering decision rather than something baked irreversibly into the stored row.

**Song length is not stored.** Nothing consumes it: the duration estimate is bracket depth times the per-match allocation, and no player-facing surface shows one.

**Playstyle prefix.** Whenever chart info is displayed, it carries a two-letter code combining playstyle and difficulty — `SX` (Single Expert), `DX` (Double Expert), `SH`/`DH` (Hard), and so on across `N`/`E`/`M`/`H`/`X`.

A tournament will normally use one playstyle or the other, but **nothing prevents a TO from including both Singles and Doubles charts in the same song pack.**

Chart flags surface to players at three points:

1. **On the chart in the Draw**, so the restriction informs Protect/Veto strategy.
2. **Called out in the thread** when that song comes up to be played.
3. **At score verification** — when players are confirming scores and selecting a winner for a `noCmod` chart, the bot prompts them to check that both players used the correct settings.

**Enforcement.** The bot cannot observe what modifiers a player used, so flags are enforced socially rather than technically. If a player completed the song with the wrong setting:

- either competitor may press **report a settings problem**, a button the bot shows alongside the settings prompt at score verification. It escalates to the organizer alert channel with the match, song, chart, flag, reporter, and both submitted EX% values attached. Reporting outside the bot — telling a referee directly — remains available and reaches the same ruling.
- a **referee** is instructed to **grant the song win to the player who played with the correct settings**.

The report button is available only **until the song commits**. Once both players have agreed a winner the result is frozen (see Bracket Immutability), and a violation noticed after that point cannot be corrected.

**If both players used the wrong setting** there is no correct-settings player, so the bot alerts the referees and offers a choice:

- **select a winner** — appropriate when time is a constraint, since both players held the same illegal advantage and the comparison is still between equals; or
- **void the song** — no points to either player and the set moves on, handled exactly like a tied song (next chart in protect order).

In every case a referee applies the outcome as a forced result, which is permitted because the song has not yet been committed (see Bracket Immutability).

### Song Pool labeling

A format whose match uses a Song Pool instead of a Draw (Hubert's formats — see Configurability) needs every one of its required labels assigned to exactly one song before it can be used. This is a separate step from ordinary pack editing, since it is about *which* songs stand in for which labels, not the songs' own metadata.

- The song pack view carries a **tab per such format**, alongside the ordinary full pack view — a tournament using both HB-11 and HB-13, say, gets one tab each, and a song can carry a different label (or none) in each independently.
- A TO **creates a tab** for a format, then assigns each song **at most one label** from that format's required set — enforced by the UI, so there is nothing to catch after the fact for that half of it.
- **Saving never blocks.** It always keeps whatever is currently assigned and reports exactly what's still wrong: which labels remain unassigned, grouped by category, and which have been assigned to more than one song, naming the conflicting songs. A tab can be built up over several passes.
- **Starting the tournament blocks** if any Hubert format actually in play — the tournament's default, or any per-match override — still has an incomplete or conflicting Song Pool. This is one more line on the same pre-start checklist every other start guard already appears on.
- A tab, once created, may be **deleted**, which removes every label it carries; it can be recreated from nothing.
- **Labeling a tab, and deleting one, are only possible before the tournament starts** — the same boundary a format assignment itself is locked to, above, and for the same reason: a running match may already be drawing from the pool. Creating a brand-new, still-empty tab carries no such risk and stays available regardless.

### Song pack size

There is **no hard minimum**. A TO may start a tournament with a song pack of any size — the general reshuffle rule (see **How the bot draws charts**) absorbs any shortfall, including song packs smaller than the 7 charts a Draw requires.

Small song packs produce visibly repetitive behaviour: charts recur across matches, and below 7 a single Draw can contain the same chart more than once. This is permitted on the assumption a TO doing it is doing it deliberately.

The bot **always warns** when the song pack is below the size the tournament's ruleset recommends, naming that size and what the TO should expect. For the Bo5 ruleset it is **10 charts** — 7 for a Draw plus 3 for one tiebreak round with no repeats. Another ruleset with a different draw recommends whatever it needs. The warning never blocks the start.

### Building a song pack

TOs can populate a song pack by:

- **Importing a source pack** — a StepMania `.zip` or folder. The source pack is **parsed entirely client-side**; the simfiles themselves are never uploaded. The browser produces a JSON chart list which is what gets sent to the server.
- **Editing the resulting charts** individually through the web UI — correcting metadata, setting flags, removing charts.

  Two fields are imperfect by nature and expected to be cleaned up here:

  - **Stepartist** is read from `#CREDIT` and **description** from `#DESCRIPTION`. Neither is filled in consistently across packs. Missing ones are left blank for an organizer to complete.
  - `.sm` files carry only one such field rather than two. It becomes the **stepartist**, and the description is left empty.
  - **The `noCmod` flag** is set automatically when a case-insensitive search for "no cmod" matches the title or subtitle, which is how packs actually mark it. An organizer can set or clear the flag on any chart afterwards.

- **Copying a song pack from a previous tournament** on the same server.

**Bulk paste and file import of a chart list are deferred.** Importing a source pack and editing afterwards covers how a pack actually gets built; pasting a list is a convenience that can be added once the rest is in use.

### Editing a pack during a tournament

Charts may be corrected at any time, including while a tournament is running — a wrong meter or a mistyped title found during play should be fixable.

**Corrections never alter what already happened.** Every chart the bot draws is recorded with the metadata it had at the moment it was drawn, so past matches always render as they were played. An edit changes the pack, and every draw from then on; it does not reach backwards.

A TO may also **remove** a chart, and removing one that has already been played does not damage the record — past matches still render it as it was. This is unrelated to charts never being removed *by the system* once played, which is a statement about how draws work rather than about editing (see **How the bot draws charts**).

## Configurability

A TO configures a tournament by **choosing its default match ruleset**, optionally **overriding it per round or per match**, and **setting timer durations**. Nothing inside a ruleset is adjustable — set length, Draw size, and action order are properties of the ruleset itself, not knobs.

**A ruleset belongs to a match, not to a tournament.** Every match records the ruleset it ran under: an explicit per-match assignment if the TO made one, otherwise the tournament's default. This is the config shape that lets an event short on machines play Bo3 through the early rounds and Bo5 for Winners Finals, Losers Finals, the Grand Finals and its reset — one example of an arbitrary need, not a special case the system only half-generalizes.

Assigning a format needs a real match to assign it to, so a TO can generate the bracket once check-in has closed, ahead of starting the tournament — the same graph that would otherwise only appear at start, just available earlier for exactly this reason. From there, a format is assignable per round or per individual match, from the web bracket page or `/tournament format`'s `target` option (a round or a specific match, chosen from a live list — omitting it targets the tournament default instead). Regenerating the bracket after the field changes keeps every assignment that still applies to the same matches; if the field crosses to a different bracket size, assignments reset and the TO reassigns from the newly-shaped bracket rather than the system guessing where an assignment belongs now.

**A format assignment is only ever editable before the tournament starts.** This holds even for a match that has not been reached yet — a still-`PENDING` Grand Final, say, while round 1 is still being played — because a running tournament may already be drawing from whatever pool that match's format implies (see "Song Pool labeling," below, for the same boundary applied to that pool itself). Once the tournament has started or finished, the format a match carries is fixed.

Changing the tournament's default once matches actually disagree with each other puts a three-way choice to the TO, identically on the web and in Discord: update every match to the new default, change only the default going forward, or cancel and leave both untouched.

The match ruleset is **pluggable** rather than hardcoded logic, so further rulesets — prisoner's-dilemma-only, fixed song list, and others — can be added without reworking the system. **Bo5, Bo3, and Hubert's formats all ship**; a tournament defaults to Bo5.

Bo3 plays the same way as Bo5 in every respect not called out below: the same photo-and-EX% scoring step, the same tiebreak process once the Draw is exhausted. It differs in scale and one structural rule:

- **5-chart Draw**, not 7. A player wins the set by reaching **2 points**, not 3.
- **Protect, Protect, Veto, Veto** — no second Protect round. Protects go to whichever player took the first Protect (A) then the other (B), same as Bo5. Vetoes go **by seed**, not by role: the higher seed automatically holds the first Veto, the lower seed the second — the counterpart to the higher seed's own choice between the first and second Protect.
- **Play order is fixed**, not loser-preference: the first Protect, then the second Protect, then the Decider if the set is still undecided. Unlike Bo5, who won the previous song has no bearing on which chart plays next.

### Hubert's formats

**HB-11** and **HB-13** — named for song count, 11 or 13 — depart from Bo3/Bo5 almost entirely: a fixed, TO-labeled Song Pool instead of a random Draw, a different action order, and an endgame that can't loop forever the way Bo3/Bo5's tiebreak can. What they share with Bo3/Bo5 is only the photo-and-EX% scoring step and the shape of a song's own resolution (both players agree, or a referee rules).

**The Song Pool.** Every song in the tournament's song pack carries at most one label per Hubert format, assigned by the TO ahead of time — see "Song Pool labeling," below. A match doesn't draw charts at all: its Song Pool *is* the full labeled set for that format, every time, unchanged match to match. The labels themselves are fixed by category:

| Category | HB-11 | HB-13 |
| --- | --- | --- |
| Reading (RD) | 5 | 6 |
| Focused-Tech (FT) | 3 | 3 |
| Fundamentals (FN) | 2 | 3 |
| Tiebreaker (TB) | 1 | 1 |

The Tiebreaker song is reserved: it is never available to Veto or to pick, and enters play only as the forced tiebreaker described below.

**A coin flip decides who is Player A** — not seeding, since these formats have no Protect step to choose an order for. The assignment is made once, when the match opens, and stands for the rest of the match: it is not part of what a referee's reset (see Bracket Immutability) clears.

**Vetoes only, no Protects.** HB-11: Player A vetoes one song, then Player B vetoes one. HB-13: A, B, A, B — four vetoes. **On HB-13, a player may not use both of their vetoes on the same category** — Player A cannot veto two Reading songs. There is no restriction across players: Player A vetoing a Reading song and Player B separately vetoing a different Reading song is fine.

**Players choose the play order.** Once vetoes finish, **Player B selects the first song to play, then picks alternate players from there** — the opposite of Bo3/Bo5, where the bot determines play order and no player ever chooses.

**Scoring matches Bo5**: 1 point for a win, 0 for a tie, first to 3 points wins outright.

**The endgame** is score-triggered rather than pool-exhaustion-triggered, and it resolves in stages instead of replaying indefinitely:

1. First to 3 points wins outright, same as Bo5.
2. Short of that, the reserved Tiebreaker song is forced the moment either condition holds: the score reaches 2-2, or every other song has already been used up by ties. It is scored exactly like any other song.
3. Once the Tiebreaker has been played, the set is decided by **most points**; if that's equal too, by **higher average EX%** across every song played; if that's equal as well — a genuine tie on both — the match escalates to a **referee**, the same as any other stalled match.

Unlike Bo3/Bo5, where every song tying can in principle generate tiebreak rounds forever, a Hubert-format match always terminates on its own or lands in front of a referee — the pool the endgame draws from is fixed in size, not replenished.

## Automation Boundary

**The only outcomes the bot commits on its own are ones both players have signed off on** — an agreed song winner, and a set result the players have thereby already agreed to, whether or not a win condition was reached before the last song they agreed on. Everything else is a referee decision.

Specifically, the bot **never**:

- forfeits a match on its own,
- disqualifies a player on its own,
- picks a Protect or Veto on a player's behalf, or
- advances the bracket **on the basis of a match outcome** without either mutual player agreement or a referee ruling.

**Byes are exempt.** A player receiving a round 1 bye has no opponent to be matched against, so there is no match outcome to agree on and nothing for a referee to rule. The bot advances them as a matter of bracket structure.

Forfeits and disqualifications exist as **referee-initiated** actions (`/dq` and the web UI) — the boundary is that the bot never reaches those outcomes by itself, no matter how long a player is silent.

The bot also **does not nudge players**. A player waiting on an unresponsive opponent handles that themselves. The bot's only role in a stalled match is to **alert the organizers** so someone can move it along.

## Timers

Timers are **alert thresholds, not enforcement**. Each is configurable by a Tournament Organizer, and expiry posts to the organizer alert channel without changing match state.

- **Match start window** — default **10 minutes**. Players are expected to start their match within this window; if they have not, the organizers are alerted.
- **Overall match time limit** — default **25 minutes**, matching the duration-estimate allocation. Exceeding it alerts the organizers so the event stays on schedule.

**Both clocks start when the thread is created and both players have been notified their match is ready** — not when the bracket is generated, and not merely when the thread exists. A player cannot be held to a window they have not been told about. The 25 minutes therefore covers getting started as well as playing, which is correct: it is the schedule allocation for the match's slot, not a play clock.

**A timer flags a potential delay to the people who can act on it, and that is all it does.** Two things follow, both intended. It does not measure fault, so the clock does not pause while an organizer is deliberating on an escalation — a delay is a delay regardless of cause, and the schedule does not care whose it is. And it does not nag: each threshold alerts once, after which an organizer knows and owns it.

Score reporting is deliberately **not** on a timer.

## Bracket Immutability

Once a tournament has started:

- **Seeding and matchups are locked.** Entrants cannot be added or removed.
- A player who wants out is **disqualified by a referee**, who chooses whether the disqualification covers only the current match or withdraws them from the tournament entirely (see Match Flow, Set result). Affected opponents are advanced accordingly.

**Results freeze as they commit, one song at a time.** The boundary is:

| State | May a referee intervene? |
| --- | --- |
| Protect/Veto, and song 1 itself, up until song 1's result commits | Yes — the sequence, and any progress on song 1 (a Hubert-format pick, a submitted score, an agreed-but-not-yet-final winner), can all be reset together |
| Song 2 onward, currently in progress | Yes — correct a score, force a winner on an escalation |
| Song whose winner both players have agreed | **No** — frozen |
| Protect/Veto, once song 1's result has committed | **No** — frozen |
| Set whose win condition has been reached | **No** — frozen |

A committed song result is permanent, whether it was reached by mutual player agreement or by a referee ruling. Nothing rewinds.

**Song 1 is the one song a reset can reach even after it starts.** Every other song's "currently in progress" row above is a narrower power — a referee corrects the song in front of them, but the sequence that led to it stands. Song 1 is different because the sequence that produces it (Protect/Veto, and for a Hubert format, the pick that follows it) is itself still resettable for as long as song 1 hasn't committed, so undoing song 1 and undoing the sequence that chose it are the same action. A Hubert-format reset never re-decides who is Player A — that coin flip happens once, when the match opens, and stands regardless of how many times the rest gets reset.

## Roles

Competitors are identified by their **Discord account only**. There is no separate player profile, tag, or external profile link.

**Identity vs. display.** The **Discord user ID** is the identity — it is unique, never changes, and is what every roster entry, match record, and history lookup is keyed on. The **display name as shown in the server** is captured as a **snapshot when the tournament starts** and stored with that tournament.

The snapshot is taken at the start rather than at registration because the goal is that past brackets show the name someone **competed under**. Registration can be a week before play, and a player who renames in between competed under the new name. Only the final roster is snapshotted, so nobody who never played leaves a name behind.

The name taken is the one the server shows: **server nickname if set, otherwise global display name, otherwise username.**

A player who later renames themselves keeps all their history, because the ID never moved. Past brackets continue to show the name they competed under; a new tournament picks up their current name when it starts.

### Granted roles

These are explicitly assigned and confer permissions. The first two are **server-scoped tiers, granted by assigning a Discord role**; the third is deployment-scoped and unrelated to Discord roles.

**The two server tiers are cumulative.** A Tournament Organizer can do everything a Referee can. Every capability listed below is therefore a **minimum** — naming a tier never excludes the tier above it.

**Reconfiguring the server is not a tier at all.** It is gated directly on Discord's own **Manage Guild** permission — there is no bound "Server Administrator" role to assign, and holding Manage Guild confers no tournament or match authority by itself. Whoever has it may run `/setup`, full stop; ruling on a match or running a tournament still requires the relevant tier role regardless.

**Bot Administrator is not part of that chain.** It is deployment-scoped and confers no authority over any tournament: a Bot Administrator without a tier role in a given server can view that server's brackets and rule on nothing.

| Role | Scope | Capabilities |
| --- | --- | --- |
| Referee | One Discord server | Rule on matches to unblock them — award or void a song, force a result on an escalation, reset Protect/Veto before song 1 commits, disqualify a player at either scope (a plain forfeit is a disqualification scoped to the current match). All within the limits in Bracket Immutability. **Cannot create, start, or close a tournament** |
| Tournament Organizer (TO) | One Discord server | Everything a Referee can do, plus create and configure tournaments, manage song packs, open and close registration and check-in, seed the bracket, start and cancel a tournament |
| Bot Administrator | The whole deployment | View every Discord server the bot has been added to, and the tournaments and brackets belonging to each |

**Referee exists so refereeing can be delegated.** Running an event needs more hands than running the tournament does, and someone trusted to unblock a stalled match need not be trusted to cancel the tournament.

**A server may collapse the tiers.** Pointing both tier slots at the same Discord role is a supported configuration, for servers that want the same people involved at every level.

**"Administrator" names only the deployment-scoped Bot Administrator role.** There is no server-scoped role by that name — reconfiguring a server is Manage Guild, above, not a tier — so nothing else should ever be labelled plain "Administrator."

### What each role may do

Tiers are cumulative, so each action below lists the **minimum** tier required. Anything a Referee may do, a Tournament Organizer may also do.

**In a match** — the referee's domain. Everything the organizers do during a running tournament sits here, and none of it needs a tier above Referee.

| Action | Minimum |
| --- | --- |
| Protect, Veto, submit a score, post a result photo, select a song winner, choose a tiebreak chart | Being one of the two players |
| Report a settings problem on a flagged chart | Being one of the two players |
| Award an escalated song to a player | Referee |
| Void a song | Referee |
| Correct a score on the song currently in progress | Referee |
| Reset Protect/Veto, before song 1's result commits | Referee |
| Disqualify a player, either scope, including a plain forfeit (`/dq`) | Referee |
| Dismiss a timer, departure, or permission alert | Referee |
| Read any match thread and review any match | Referee |

**Running a tournament** — everything that moves a tournament between lifecycle states, plus the setup that precedes it.

| Action | Minimum |
| --- | --- |
| Create a tournament and choose its default ruleset | Tournament Organizer |
| Set timer durations and the per-match time allocation | Tournament Organizer |
| Build, edit, import, or copy a song pack | Tournament Organizer |
| Open and close the registration window | Tournament Organizer |
| Open and close the check-in window | Tournament Organizer |
| Add, check in, un-check-in or remove any entrant, on their behalf, at any point until the tournament starts | Tournament Organizer |
| Seed entrants, at any point from the first `/join` onward | Tournament Organizer |
| Review the final seed order and start the tournament | Tournament Organizer |
| Start the tournament | Tournament Organizer |
| Cancel a tournament, including one already running | Tournament Organizer |

**Configuring the server** — gated on Discord's own Manage Guild permission, not a tier; see "Reconfiguring the server is not a tier at all" above.

| Action | Minimum |
| --- | --- |
| Run `/setup` — choose channels and the role for each tier | Discord's Manage Guild |
| Re-run the configuration diagnostic (`/setup status`) | Discord's Manage Guild |

**Across the deployment** — unrelated to the server tiers.

| Action | Minimum |
| --- | --- |
| View every Discord server the bot is in, and their tournaments and brackets | Bot Administrator |
| Promote another Bot Administrator | Bot Administrator |

**Requiring nothing at all.**

| Action | Minimum |
| --- | --- |
| View the public bracket, any match detail, and any player's history | No account, no sign-in |
| Enter a tournament (`/join`) and check in (`/checkin`) | Membership of the Discord server, while the window is open |
| See a personalized dashboard | Any signed-in Discord account |

### Granting the server tiers

- Each tier is bound to a **Discord role**, chosen during `/setup`. Membership of that role *is* the grant — there is no separate list maintained inside the application.
- Adding or removing someone is therefore done in Discord, using its own member and role management.
- The bot **records every grant and revocation** of a tier role in its own audit log, so there is a timestamped, application-side history independent of Discord's.
- Because anyone with Discord's Manage Roles permission can assign a tier role, including to themselves, **tournament start warns if any entrant also holds a tier role**, naming them. The warning does not block the start.

### Granting the Bot Administrator role

- A **configuration allowlist** of Discord user IDs is applied at every boot. It is **additive** — the bot ensures those users are administrators and never removes anyone.
- Existing administrators can **promote others through the web UI**. Promotions are stored in the database, survive restarts and redeploys, and are **logged by the application**.

**What gets logged, generally.** The application's audit log records **every action a tier permitted** — rulings, roster changes made on someone else's behalf, chart edits, tier grants, administrator promotions. It does not record self-service acts available to any member, such as a player's own `/join` or `/checkin`, which are evidenced by their own effect. The distinction is whether privilege was used, because that is the question anyone reviewing the log afterwards is asking.
- The config allowlist is therefore the **lockout recovery path**: if the database is lost or every administrator is removed, editing the config and redeploying restores access.

### Competitor is not a role

**Competitor is derived state, not a grant.** Any member of the Discord server may run `/join` while registration is open; from that point they are on the roster. Their permissions are per-match and follow from being one of the two players in a given thread — there is nothing to assign and nothing to revoke when the tournament ends.

Note that the three server tiers are **bound to** Discord roles but are not the same thing as them: the bot cares only about membership of the specific roles named during `/setup`, and ignores every other role and every native Discord permission. Bot Administrator is not a Discord role at all.

## Tournament Lifecycle

### Bracket format

- **Double elimination only**, and **every match is 1v1**. Two competitors, one advances and one drops. This is the whole of what ships.
- The data model records a match's *participants* rather than a fixed pair, so a format seating more than two is a structural addition later rather than a rewrite. Nothing supports one today, and no surface offers it.
- **Byes.** The bracket is padded to the next power of two and the **highest seeds receive round 1 byes**.
- **Losers bracket routing.** Losers drop into the losers bracket using the **standard predetermined stagger**: the order of players dropping out of a winners round is transformed (reversed or rotated) relative to the losers-bracket positions receiving them, so players from the same region of the winners bracket are separated.

  This pattern is **fixed at bracket generation** from bracket positions alone and **never reacts to results**. It is therefore seed-neutral — every player's path difficulty follows from their seed, exactly as seeding intended — while delaying rematches as long as the structure allows. A grand final rematch between two players who already met remains possible and is expected.

- **Grand final bracket reset.** The finalist coming from the losers bracket must win **two sets** to take the tournament; the winners-bracket finalist needs only one. If the losers-side finalist wins the first set, a second set is played as a **completely fresh match** — new 7-chart Draw, full ABBAAB Protect/Veto. Seed advantage follows **original seeding**, so the winners-bracket finalist keeps the first-or-second Protect choice in both sets.

Individual match rules are in **Match Flow**.

### Registration

- Competitors register with `/join`.
- The registration window is explicitly opened and closed by the TO. `/join` only works while the window is open.
- **Anything a player can do for themselves, a Tournament Organizer can do for them** — add someone who missed registration, check in a player who is present but unreachable, un-check-in, or remove. Available from both the console roster and slash commands, at any point until the tournament starts. This is a superset of the player's own window: a TO can add an entrant after registration has closed, which `/join` will not do.
- **An action taken on a player's behalf leaves the roster in exactly the state the player's own action would have.** The only additions are the audit record, and the absence of a notification where the organizer performing the action would have been the one notified. There is no second code path and no "added by an organizer" variant of an entrant.
- **Competitors may withdraw themselves with `/leave`** at any point before the tournament starts — during registration, during check-in, and after check-in has closed. Once the tournament starts, leaving requires a referee, because there is a bracket to repair.
- A withdrawal after check-in has closed **alerts the organizers**, since a TO reviewing the field before starting deserves to know it just changed. A withdrawal before that is routine and silent.
- **No roster size cap.**
- After registration closes there is a **separate check-in window**. Registered players must confirm attendance; no-shows are dropped from the roster when the tournament starts, not before (see Seeding).

### Duration estimation

This feature exists specifically to support **remote tournaments**, where every player has access to their own machine. There are no shared stations and no queueing for hardware.

- The bot estimates total tournament duration from a TO-configured per-match time allocation, defaulting to **25 minutes per match**.
- Because every match in a round can run simultaneously, the estimate is driven by **bracket depth, not match count**.
- The bot walks the generated bracket and counts the rounds that must happen **sequentially** — winners rounds, losers rounds as they interleave, and the grand final — then multiplies by the per-match allocation.
- The estimate accounts for a possible **grand final reset** as an additional round.

### Seeding

- **A player receives a seed automatically the moment they join** — the lowest-priority spot, at the back of the current order — rather than waiting for a Tournament Organizer to assign one. Check-in status is tracked separately and never affects an entrant's seed.
- **A Tournament Organizer may reorder freely at any point before the tournament starts** — during registration, during check-in, and after check-in has closed. Dragging handles small adjustments; typing a seed number directly moves someone a long way in a large field. Both write the same full order.
- Seeding is therefore never provisional in the sense of "incomplete" — every active entrant always holds a seed — but the order itself remains fully open to change up to the instant the tournament starts.
- **Only players who complete check-in participate.** Everyone who did not check in is dropped **when the tournament starts**, not before — check-in closing is a separate event from that drop, so an organizer can keep adjusting the seed order (checked-in or not) for as long as the tournament is not yet running.
- Dropping those players leaves gaps, so starting the tournament **clears their seeds** and **renumbers the survivors from 1 with their relative order preserved**. If seeds 1, 2, 3 and 4 were assigned and seed 3 never checked in, seed 3 is released and the remaining three become 1, 2 and 3 in the same order.
- A dropped player keeps their roster entry, recorded as having not checked in. They simply hold no seed, since they never competed.
- The TO reviews the final ordering **as part of starting the tournament** — the start action shows it for confirmation, and generating the bracket is what fixes it. There is no separate commit step: seeding stays freely reorderable up to that instant regardless of whether a bracket already exists for an earlier field (see "Configurability" — a TO may generate the bracket ahead of start to assign per-round or per-match formats). A withdrawal or late check-in after that earlier generation does not silently take effect; starting checks that the field still matches what was generated and asks for a fresh generation first if it does not, rather than starting against a bracket sized for a field that no longer exists.

### Starting the tournament

Every transition is an explicit TO action; nothing in the lifecycle is on a timer.

Seeding is not a step in this sequence — it runs alongside from the moment the first player joins (see Seeding).

1. TO **closes registration**.
2. TO **opens check-in**. Check-in has **no duration** — it stays open until closed.
3. TO **closes check-in**. This is a pure state change — the roster and every seed are untouched, and remain freely reorderable.
4. TO **starts the tournament**, confirming the final seed order shown to them as they do. At this moment the bot:
   - drops players who did not confirm check-in, and renumbers the surviving seeds from 1 in their existing relative order;
   - checks a bracket generated ahead of time (see "Configurability") still matches the surviving field, **blocking the start** if it does not — the TO regenerates it, which also names what happened to any per-match format assignments;
   - snapshots each remaining entrant's display name as shown in the server;
   - re-checks that all required Discord permissions are still granted, **blocking the start** if any are missing;
   - warns if the song pack is below the recommended minimum for every format the bracket carries, **without** blocking;
   - generates the bracket if none exists yet, or reuses the one already generated for this exact field; either way creates the round 1 match threads and notifies players.

## Discord Surface

- The bot uses **slash commands with interactive components** throughout. There are no prefix (`!`) commands. Protect/Veto actions, winner selection, and tiebreak song selection are all component-driven — buttons where the choice is a small fixed set, and a **select menu** where the choice is one chart out of several, so each option can carry its meter, stepartist and flags alongside its title.
- Matches take place in **threads under a single matches channel**, not in dedicated channels.
- A match thread is **private to the two competitors and anyone holding a server tier role**. Spectators do not have read access.
- The bot keeps **exactly one live prompt** in each thread, always as the most recent message, so a player never scrolls past their own result photos to find what they must do next. Everything else the bot posts — the Draw, each committed song result, the final summary — is permanent and never changes.
- On creating a thread the bot adds **only the two competitors** as members. Organizers see match threads through Discord's **Manage Threads** permission on the matches channel, which every tier role must hold — so a thread has two members however large the referee pool is, and someone granted a tier mid-tournament can immediately read every open match.
- Each player may only submit **their own** score and **their own** Protect/Veto actions.
- On match completion the bot **posts a result summary** — songs played, per-song scores and winners, any tiebreak songs, and the final result — as the last message in the thread.
- The thread is then **auto-archived immediately**.
- The bot also posts a **one-line result to the results channel**, naming the round, both players, the winner and the score, and linking the match on the public bracket. That message is then **forwarded to the general channel**, so the results channel stays a clean chronological record while the server's main channel carries the visibility.
- **The matches channel itself carries no bot content at all.** It exists to host match threads and to hold the permissions that make them work. No round announcements, no match-ready pings, nothing while a match is in progress.
- Nothing in the results feed is private — the same result is already public on the bracket — so it discloses nothing the web view does not.
- **Threads are never deleted.** They stay archived in Discord indefinitely, which keeps every posted result-screen photo available after the event.

The web backend remains the system of record for structured data — every chart drawn, protected, vetoed and played, every EX% and every song winner. The archived threads are the durable home for the **photos**, which the application itself never stores.

**Accepted risk.** "Never deleted" is a rule the bot follows, not one it can enforce — anyone with Manage Threads can delete a thread, and the photos in it are then gone for good. This is accepted: photo retention is best-effort and depends on Discord. No structured data is affected, since EX% values, song winners, and the bracket all live in the backend.

### Command inventory

| Command | Minimum | Effect |
| --- | --- | --- |
| `/join` | Any server member | Enter the open tournament. Works only while the registration window is open |
| `/checkin` | A registered entrant | Confirm attendance during the check-in window |
| `/leave` | An entrant | Withdraw from the tournament, any time before it starts |
| `/pack` | Any server member | Get a link to the current tournament's song pack |
| `/tournament status` | Any server member | See the current tournament, its stage, and which of `/join`, `/checkin`, `/leave` work right now |
| `/commands` | Any server member | List every command, grouped by the minimum role that can run it |
| `/roster` | Tournament Organizer | Add, check in, un-check-in or remove an entrant on their behalf |
| `/setup` | Discord's Manage Guild | Server setup — point the bot at the matches, organizer alert, results and general channels, and the Discord role for each tier. Re-runnable |
| `/setup status` | Discord's Manage Guild | Re-run the configuration and permission diagnostic without changing anything |
| `/dq` | Referee | Disqualify a player, choosing whether it applies to this match only (which also covers a plain forfeit — a no-show, or a player conceding) or withdraws them from the tournament |

`/setup` is gated on Manage Guild alone, not a tier — a freshly-invited server has no tier roles yet, so this also doubles as the permanent recovery path if the roles are later deleted or misconfigured, with nothing else to fall back to.

Match play itself uses **components, not commands** — Protect, Veto, score submission, winner selection, and tiebreak song selection all happen inside the match thread. Where a component needs a typed value, it opens a **modal** rather than asking for a chat message; EX% entry is the only such case.

| Step | Component |
| --- | --- |
| Choose first or second Protect | Two buttons |
| Protect, Veto | Select menu over the eligible charts |
| Submit score | Button, opening a modal |
| Select the song winner | Three buttons — each player, or tie |
| Tiebreak selection | Select menu over the three drawn charts |
| Report a settings problem | Button |

The one thing players post as an ordinary message is the **result-screen photo**.

### Rulings

Referees can rule from any surface:

- **From the organizer alert channel.** Escalation and timer alerts carry action buttons for the common rulings — award the song to either player, void the song, open the match in the web UI.
- **From slash commands**, for anything the alert buttons do not cover.
- **From the web UI**, which retains the full set of override capabilities.

**Authorization.** Button interactions and organizer slash commands are authorized by resolving the acting user's **tier** — the highest of the two configured Discord roles they hold — and comparing it against what the action requires. Every ruling in the alert channel requires **Referee**; nothing there requires more. A user below the required tier receives an ephemeral rejection visible only to them.

Only the specific roles named during `/setup` are consulted. No other Discord role and no native Discord permission grants authority over a tournament — Manage Guild included — so someone who administers the server in Discord's own terms but has not been given a tier role still cannot rule on a match.

Buttons remain *visible* to anyone who can read the channel; enforcement happens on the click. The organizer alert channel is expected to be permission-restricted in Discord as a first gate.

## Notifications

- The bot **announces when check-in opens**, in the general channel, and **direct messages every registered player**. The channel post carries no mentions. Missing check-in means missing the tournament, so this is the one lifecycle event a player cannot be expected to discover on their own.
- The bot also **announces in the general channel when registration opens** — a no-mentions post inviting anyone watching to `/join`. No direct message accompanies it: nobody is registered yet to DM.
- The bot **notifies both players when a new match is ready** — that is, when their next-round opponent is determined and the thread has been created. It does this **twice**: by mentioning them in the thread, and by **direct message**.
- A separate **organizer alert channel** receives escalations, timer alerts, and disputes — and, as a plain activity log, every tournament lifecycle transition and every roster change (`/join`, `/checkin`, `/leave`, and every `/roster` action), attributed to who did it.

**The direct message is best-effort.** Discord lets a user refuse DMs from server members, and a bot cannot override that or detect it in advance — the send simply fails. The thread mention is therefore the notification of record, and a failed DM is logged and never retried. A player who has DMs closed loses nothing but the second nudge.

Direct messages are used for **exactly two things**: check-in opening, and a match becoming ready. Both share a rationale — something now needs the player's attention that they cannot otherwise discover. They are never used to prompt a pending action, deliver results, or carry anything a player must act on; every interaction stays in the match thread where both players and the organizers can see it.

Because both are best-effort, the organizer roster view shows **who could not be reached**, so a player with DMs closed can be chased by a human rather than silently dropped.

The bot does **not** ping a player to prompt a pending action (see Automation Boundary).

## Server Setup

- **`/setup`** runs server setup and can be re-run at any time. For each channel the administrator may either **point the bot at an existing one** or **have the bot create it**, already provisioned with the right permissions:

  | Channel | Purpose | Required |
  | --- | --- | --- |
  | **Matches** | Hosts match threads. No bot messages are ever posted in its body | Yes |
  | **Organizer alerts** | Escalations, timer alerts, disputes | Yes |
  | **Results** | Read-only log: one line per finished match, in order. Organizers watch it to see the event progressing | Yes |
  | **General** | Receives a forward of each result line, so competitors can react and discuss as the event runs | No |

  Plus a Discord role for each of the three tiers. The same role may be given for more than one tier.

- **Results deliberately land in two places, for two audiences.** The results channel is a clean chronological log with no conversation in it, which is what makes it useful to organizers tracking an event in progress. The forward into the general channel is where competitors react and talk, without that traffic burying the log.
- **The general channel is optional and never blocks setup.** Left unset, results post to the results channel and nothing is forwarded. The organizer-facing half still works exactly as described; competitors follow the event on the public bracket instead.
- A **guided first-run wizard** in the web UI walks a new server through server configuration, building a song pack, and creating its first tournament.
- **Creating a channel is the recommended path.** A channel the bot makes is correct by construction — the right overwrites for the bot, for each tier role, and for `@everyone` — so there is nothing to diagnose and nothing for the administrator to know about Discord's permission model.
- **Selecting an existing channel accepts any choice.** No picker is filtered. The bot then computes what is missing and **offers to fix it**, showing exactly which overwrites it would add before changing anything. Nothing is modified without the administrator confirming.
- **The bot cannot always fix it.** Discord limits what permissions one actor may grant another. Whatever cannot be repaired is reported instead, naming *where* the permission was lost — absent from the role, or denied by a channel overwrite — because the fix differs.
- **Reporting is still the fallback, and never blocks the selection.** An administrator who declines the fix, or hits something the bot cannot repair, still gets their configuration saved along with a list of what remains. The report offers a one-click re-check and is available any time via `/setup status`.
- **Self-provisioning is optional.** Creating and repairing channels needs Manage Channels and Manage Roles. A server that would rather not grant those simply does not, and setup falls back to selection with a diagnostic — every other part of the bot works unchanged.
- **Tournament start remains the blocking gate.** Permissions are re-checked there and the start is blocked if anything required is missing or has since been removed.

## Authentication

- Organizers and bot administrators sign in to the web UI with **Discord OAuth**.
- Organizer access is **granted by Discord role membership**, using the roles bound to each tier during `/setup`. Signing in is never required to hold a tier: a referee can work entirely from Discord, since alert-channel buttons and slash commands are a complete workflow.
- Only `identify` scope is requested. Which servers a signed-in user may act in is resolved from their tier role membership, not from the OAuth token.

## Organizer Web UI

Each item names the **minimum** tier required; higher tiers have it too.

- Tournament setup and registration management *(TO)* — create a tournament, **choose its default ruleset**, set timer durations and the per-match time allocation, open and close the registration and check-in windows, manage the roster.
- Song pack management *(TO)* — build and edit the song pack for each tournament, and label the Song Pool for any Hubert format in play (see Song Packs, "Song Pool labeling").
- **Manual seeding** interface *(TO)* — reorder by dragging, or type a seed number directly to move someone a long way in a large field. Both write the same order.
- **Run view** *(Referee)* — the screen an organizer sits on during an event. Two panes: the **alert queue**, showing everything awaiting a human, and a **live match list**, one row per in-progress match with its round, players, current song and running score. The bracket tree is available but is not this screen; a tree explains structure, a list answers which matches are slow.
- **Live bracket view** *(Referee)* — real-time match states, current song, and running scores.
- **Match detail** *(Referee)* — one page per match, reachable from an alert, from the bracket, and from the match list. Every override happens here, so a referee who notices a problem the bot has not flagged has somewhere to act.
- **Match intervention / overrides** *(Referee)* — see Bracket Immutability for the boundary. A referee may act on the **song currently in progress**, reset a Protect/Veto **before song 1's result commits**, force a result on an escalated song, disqualify a player, and apply forfeits.

## Public Web View

Competitors and spectators have access to a public bracket page. Clicking a match reveals:

- the songs drawn for that match
- the full Protect/Veto action sequence
- who won each song, and the scores each player entered
- the songs drawn and played for any tiebreak rounds
- the final match result

The public bracket is **fully mobile-usable** — spectators are assumed to be on phones. The organizer web UI is **desktop-first**; organizers are assumed to have a laptop at the event.

The public bracket updates by **real-time push** — bracket state and in-progress match state change without the viewer refreshing.

### The pack tab

The public tournament view carries a **tab showing that tournament's song pack**, so competitors can see and prepare against exactly what may be drawn.

- Every chart, with its playstyle prefix, meter, stepartist, source pack and any flags.
- A **text search** that matches across title, subtitle, artist, source pack and stepartist together — in both their original and transliterated forms, tolerant of partial and out-of-order words. It filters as you type, on a short debounce, with no button to press.
- Filters for **difficulty** and **meter**, plus **playstyle** — which is hidden when the pack contains only one, since a filter with a single option is noise.
- A **`noCmod` checkbox**. It is the only flag that exists; if others are added this becomes a general flag filter.

`/pack` returns a link to this tab for the server's current tournament, and tells the player if there is not one.

## Results and History

- On completion the bot posts **final standings** in Discord — the winner down through **8th place**. Players the bracket cannot separate **share a placement**, and the next placement skips accordingly — 5th, 5th, 7th, 7th. It goes to the results channel and is forwarded to the general channel, exactly as each match result was. The full placement order, uncapped, lives on the permanent results page — see below.
- The **public results page persists** after the event as a permanent archive at a URL that never changes and is never reused.
- **Match history is public.** Any visitor can browse any player's past matches and scores on that server without signing in. A player page shows their matches — opponent, round, score, link to the detail — and their win-loss record for that server.
- **Player pages are excluded from search engine indexing.** Brackets and match pages are indexed, because an event is a public thing worth finding. A permanent page ranking for a person's name and listing every match they lost is not the same thing, and entering a tournament is not consent to it. Player pages stay fully browsable by link.
- Players may sign in with **Discord OAuth** to get a personalized dashboard: a link into their live match, their standing in the running tournament, and their past events in that server. **Sign-in adds convenience and never capability** — nothing it shows is unavailable without it.

## State, Persistence, and Multi-Tenancy

- **Full state is persisted.** A restart mid-Protect/Veto or mid-set resumes exactly where it left off.
- A single bot instance serves **multiple Discord servers**, each with independent tournaments and song packs.
- **One tournament per Discord server, held from the moment it is created.** A new tournament cannot be created until the current one is cancelled or reaches completion — there is no separate "preparing the next one" state that doesn't count.
- **Historical results are retained** and remain queryable after an event ends.
- History is **scoped to the Discord server** it belongs to.
- The bot administrator can see which servers the bot has been added to and view the tournaments and brackets belonging to each.

## Non-Functional Requirements

- **Scale.** Target local-event scale initially — on the order of tens of entrants per tournament — but the design must accommodate growth to larger fields and more servers without rearchitecting.
- **Extensibility.** Match formats are pluggable (see Configurability).
- **Recoverability.** No tournament state is lost across a bot restart (see State, Persistence, and Multi-Tenancy).
- **Accessibility.** The **public bracket targets WCAG 2.1 AA** — sufficient contrast, full keyboard operability, visible focus indicators, semantic markup and labelling for screen readers, and real-time bracket updates announced rather than silently swapped in. It faces a wide, unknown audience, so it carries the formal bar.

  The **organizer web UI is best-effort**: its audience is small and known, and it is desktop-first by design. Accessibility problems there should still be fixed when found, but no conformance level is required.

## Non-Goals

Explicitly out of scope:

- **Automatic score capture.** Scores are always self-reported; no GrooveStats or cabinet integration is planned.
- **Team tournaments.** Competitors are always individuals. (Doubles *charts* are supported — doubles is a chart type, not a team format.)
- **Formats seating more than two players in one match**, and the pool or phase structures they would need. Every match is currently between two competitors. The data model records participants rather than a fixed pair, so this is a structural addition rather than a rewrite, but nothing supports it today.
- **Streaming and casting tools.** No overlays, commentator views, or broadcast integrations.
- **Payments, prizes, or entry fees.** The system handles no money.
