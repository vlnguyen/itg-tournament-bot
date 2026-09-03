import { Accordion, Anchor, Badge, Code, Divider, List, Stack, Table, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';

const TOC: { id: string; label: string }[] = [
  { id: 'signing-in', label: 'Signing in' },
  { id: 'adding-the-bot', label: 'Adding the bot to your server' },
  { id: 'configuring', label: 'Configuring the server' },
  { id: 'creating-a-tournament', label: 'Creating a tournament' },
  { id: 'song-pack', label: 'Building the song pack' },
  { id: 'phases', label: 'Tournament phases' },
  { id: 'registration', label: 'Opening registration' },
  { id: 'checkin', label: 'Check-in' },
  { id: 'seeding', label: 'Seeding' },
  { id: 'starting', label: 'Starting the tournament' },
  { id: 'playing-a-match', label: 'Playing a match' },
  { id: 'disputes', label: 'Handling disputes' },
  { id: 'tracking', label: 'Tracking a live event' },
  { id: 'finishing', label: 'Finishing the tournament' },
  { id: 'commands', label: 'Command reference' },
  { id: 'faq', label: 'FAQ' },
];

/** One row of the command reference table. */
function Cmd({ children }: { children: string }): JSX.Element {
  return <Code>{children}</Code>;
}

/**
 * `/help` — a public, static walkthrough of the whole tournament lifecycle,
 * start to finish. No data fetching and no sign-in gate, matching every
 * other page's "sign-in is information, never a gate" principle — this one
 * doubles down on it, since the entire point is to be readable before
 * anyone has an account.
 */
export default function Help(): JSX.Element {
  return (
    <Stack gap="xl" p="md" maw={860} mx="auto">
      <div>
        <Title order={1}>Help &amp; FAQ</Title>
        <Text c="dimmed" mt="xs">
          A start-to-finish walkthrough of running a tournament with ITG Tournament Bot: from signing in, through adding the bot
          to your server, to posting final standings.
        </Text>
      </div>

      <nav aria-label="Table of contents">
        <List size="sm" spacing={4}>
          {TOC.map((item) => (
            <List.Item key={item.id}>
              <Anchor href={`#${item.id}`}>{item.label}</Anchor>
            </List.Item>
          ))}
        </List>
      </nav>

      <Divider />

      <div>
        <Title order={2} id="signing-in">
          Signing in
        </Title>
        <Text mt="xs">
          Sign in with the <Anchor href="/api/auth/login">Sign in</Anchor> link in the header. It's Discord's own login, and it
          never gates anything the bot can do. A referee can rule on every match from Discord alone, buttons and slash commands,
          and never needs to open the web app.
        </Text>
        <Text mt="xs">
          What signing in adds: the homepage lists every Discord server you manage (even ones the bot hasn't been added to yet),
          and a personal dashboard with a link to your live match, your standing in the running tournament, and your past events
          in that server.
        </Text>
      </div>

      <div>
        <Title order={2} id="adding-the-bot">
          Adding the bot to your server
        </Title>
        <Text mt="xs">
          Sign in, then look at the <Anchor component={Link} to="/">home page</Anchor>. Every server where you have Discord's{' '}
          <strong>Manage Server</strong> permission shows up as a card. One the bot already shares with you links straight to
          that server's page; one it hasn't joined yet shows an <Badge variant="light">Add to server</Badge> badge. Click it,
          confirm, and Discord takes you to its own authorization screen, where you pick the channels and grant the permissions
          the invite asks for.
        </Text>
      </div>

      <div>
        <Title order={2} id="configuring">
          Configuring the server
        </Title>
        <Text mt="xs">
          Whoever has Manage Server runs setup: either <Cmd>/setup channels</Cmd> and <Cmd>/setup roles</Cmd> in Discord, or the{' '}
          <strong>Server Settings</strong> page linked from your server's overview. Both do the same thing and are safe to mix.
        </Text>
        <Text mt="xs">Setup points the bot at:</Text>
        <List size="sm" mt={4}>
          <List.Item>
            <strong>Four channels</strong>: <em>Matches</em> (holds private match threads), <em>Organizer alerts</em> (the
            referee/organizer work queue), <em>Results</em> (a clean, chronological log of every finished match), and optionally{' '}
            <em>General</em> (forwards results and announcements for competitors to see).
          </List.Item>
          <List.Item>
            <strong>Two roles</strong>: <em>Referee</em> (can rule on disputed matches) and <em>Tournament Organizer</em> (can
            run the tournament lifecycle: everything a referee can do, plus creating, starting, and cancelling tournaments). A
            server that wants one tier can point both slots at the same role.
          </List.Item>
        </List>
        <Text mt="xs">
          Every channel and role can either be created for you or point at something that already exists. Setup accepts any
          selection and then reports a diagnostic listing what's still missing and where the permission was lost. Fix the
          problem in Discord, click <em>Re-check</em>, and see what's left. Nothing here blocks a save; the diagnostic is only
          enforced when the tournament starts.
        </Text>
      </div>

      <div>
        <Title order={2} id="creating-a-tournament">
          Creating a tournament
        </Title>
        <Text mt="xs">
          A Tournament Organizer runs <Cmd>/tournament create &lt;name&gt;</Cmd>, or clicks <strong>Create</strong> next to
          "Active Tournament" on the server's page. Either way the tournament starts in <Badge color="gray">Draft</Badge> and
          claims the server's one tournament slot. A server can only hold one tournament at a time, draft included, so you have
          to rename it, cancel it, or carry it through before creating another.
        </Text>
      </div>

      <div>
        <Title order={2} id="song-pack">
          Building the song pack
        </Title>
        <Text mt="xs">
          Open the tournament's <strong>Song Pack</strong> tab and use <strong>Import pack</strong> to load a StepMania folder or
          a <Code>.zip</Code>. Your browser parses everything, so the simfiles themselves never reach the server. From
          there, edit any chart's metadata, toggle flags, remove charts, and search across title, subtitle, and stepartist
          (original and transliterated). Editing is safe at any time, even mid-tournament, and copying a pack from a past
          tournament is the fastest way to start a recurring event.
        </Text>
      </div>

      <div>
        <Title order={2} id="phases">
          Tournament phases
        </Title>
        <Text mt="xs">
          A tournament moves through phases in one direction, one step at a time:
        </Text>
        <List size="sm" mt={4} type="ordered">
          <List.Item>
            <Badge color="gray" variant="light">Draft</Badge> — created, not yet visible to competitors
          </List.Item>
          <List.Item>
            <Cmd>/tournament open-registration</Cmd> → <Badge color="blue" variant="light">Registration open</Badge>
          </List.Item>
          <List.Item>
            <Cmd>/tournament close-registration</Cmd> → <Badge variant="light">Registration closed</Badge>
          </List.Item>
          <List.Item>
            <Cmd>/tournament open-checkin</Cmd> → <Badge color="blue" variant="light">Check-in open</Badge>
          </List.Item>
          <List.Item>
            <Cmd>/tournament close-checkin</Cmd> → <Badge variant="light">Check-in closed</Badge>
          </List.Item>
          <List.Item>
            <Cmd>/tournament start</Cmd> → <Badge color="green" variant="light">Running</Badge>
          </List.Item>
        </List>
        <Text mt="xs">
          Each command only works from the phase right before it. Try to skip one — opening check-in while registration is still
          open, say — and the bot refuses and names the phase it expected instead. <strong>Close registration before you open
          check-in.</strong> Some steps also run in reverse: <Cmd>/tournament open-registration</Cmd> reopens a tournament stuck
          in <Badge variant="light">Registration closed</Badge> or later, and <Cmd>/tournament open-checkin</Cmd> reopens one
          stuck in <Badge variant="light">Check-in closed</Badge>, for when you closed a phase too early.
        </Text>
        <Text mt="xs">
          Seeding isn't a phase of its own — the bot seeds every player the moment they join, and keeps adjusting the order
          until the tournament starts. There's no separate seed or generate-bracket step; <Cmd>/tournament start</Cmd> builds
          the bracket from whatever seeding is in place at that moment.
        </Text>
      </div>

      <div>
        <Title order={2} id="registration">
          Opening registration
        </Title>
        <Text mt="xs">
          Run <Cmd>/tournament open-registration</Cmd> (or the equivalent button on the tournament's <strong>Configuration</strong>{' '}
          page). This posts an announcement to the general channel and lets competitors run <Cmd>/join</Cmd> to register. A
          player can join more than once with no error, and can <Cmd>/leave</Cmd> at any point before the tournament starts.
        </Text>
        <Text mt="xs">
          When you're done taking registrants, run <Cmd>/tournament close-registration</Cmd>. This is a required step, not an
          optional one: registration has to be closed before check-in can open.
        </Text>
      </div>

      <div>
        <Title order={2} id="checkin">
          Check-in
        </Title>
        <Text mt="xs">
          Once registration is closed, run <Cmd>/tournament open-checkin</Cmd> to open check-in. Every registered player gets a
          direct message with a link back to the server, and can confirm attendance with <Cmd>/checkin</Cmd>. The{' '}
          <strong>Seeding</strong> page marks who has checked in and whose check-in DM the bot couldn't deliver, so an organizer
          can chase down anyone it couldn't reach.
        </Text>
      </div>

      <div>
        <Title order={2} id="seeding">
          Seeding
        </Title>
        <Text mt="xs">
          The bot seeds a player automatically the moment they join, at the back of the order. On the tournament's{' '}
          <strong>Seeding</strong> page, drag an entry to reorder it, or type a seed number directly for a big jump. Nothing
          locks in until the tournament starts. A late check-in or a withdrawal can still change the field right up to that
          moment. An organizer can also act on a player's behalf with <Cmd>/roster add</Cmd>, <Cmd>/roster checkin</Cmd>,{' '}
          <Cmd>/roster uncheckin</Cmd>, and <Cmd>/roster remove</Cmd>; <Cmd>/roster list</Cmd> is public and needs no permission.
        </Text>
      </div>

      <div>
        <Title order={2} id="starting">
          Starting the tournament
        </Title>
        <Text mt="xs">
          Run <Cmd>/tournament start</Cmd> once there are at least two checked-in entrants. Starting checks Discord permissions
          again and blocks on anything missing; a song pack below the recommended size warns but never blocks. On success,
          starting drops anyone who never checked in, renumbers the survivors from 1, generates the bracket, opens a private
          match thread for every round-one match, and notifies each pair of players.
        </Text>
      </div>

      <div>
        <Title order={2} id="playing-a-match">
          Playing a match
        </Title>
        <Text mt="xs">Everything a match needs happens inside its private thread, in order:</Text>
        <List size="sm" mt={4} type="ordered">
          <List.Item>The bot reveals a draw of charts, then the higher seed picks first in Protect/Veto.</List.Item>
          <List.Item>
            For each song, both players submit their EX% score and post a results-screen photo; once both have, they agree on a
            winner (or a tie) with one tap each.
          </List.Item>
          <List.Item>The bot posts a running log as the set continues, and a final result summary once the set ends.</List.Item>
        </List>
      </div>

      <div>
        <Title order={2} id="disputes">
          Handling disputes
        </Title>
        <Text mt="xs">
          If the two players don't agree on a song's winner, the match escalates immediately, with no retries and no timers. The
          organizer alert channel (and the Organizer Console's alert queue) is the work queue: anyone at Referee tier or above
          can pick it up and rule from the alert's own buttons, or from the match thread with <Cmd>/rule song</Cmd> / <Cmd>/rule set</Cmd>.{' '}
          <Cmd>/dq</Cmd> disqualifies a player from just the current match, or from the whole tournament (which cascades a walkover
          through the rest of their bracket).
        </Text>
      </div>

      <div>
        <Title order={2} id="tracking">
          Tracking a live event
        </Title>
        <Text mt="xs">
          The <strong>Organizer Console</strong> is the screen to keep open while an event runs: an alert queue (oldest first:
          whatever's waited longest is holding up a round) and a live match list showing every in-progress match, its current
          chart, and how long it's been going. Anyone can follow along on the public{' '}
          <strong>Standings/Bracket</strong> page, which updates live with no refresh needed.
        </Text>
      </div>

      <div>
        <Title order={2} id="finishing">
          Finishing the tournament
        </Title>
        <Text mt="xs">
          Once the grand final ends, the bot posts full final standings to the results channel (forwarded to general) and moves
          the tournament to <Badge color="green">Complete</Badge>, freeing the server's slot for a new one. Nothing is deleted.
          The tournament's page is a permanent archive at the same URL forever, every player gets a page showing their record in
          that server, and the dashboard keeps a signed-in user's past events in one place.
        </Text>
      </div>

      <div>
        <Title order={2} id="commands">
          Command reference
        </Title>
        <Text mt="xs"><Cmd>/commands</Cmd> also lists every command in Discord, grouped the same way.</Text>

        <Title order={3} size="h5" mt="md" mb={4}>
          Anyone
        </Title>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                <Cmd>/join</Cmd>
              </Table.Td>
              <Table.Td>Register for the current tournament</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/checkin</Cmd>
              </Table.Td>
              <Table.Td>Check yourself in</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/leave</Cmd>
              </Table.Td>
              <Table.Td>Withdraw from the tournament</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament status</Cmd>
              </Table.Td>
              <Table.Td>See the current tournament and what you can do right now</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/roster list</Cmd>
              </Table.Td>
              <Table.Td>See who is on the tournament roster</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/pack</Cmd>
              </Table.Td>
              <Table.Td>Summarize the tournament's chart pack</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/commands</Cmd>
              </Table.Td>
              <Table.Td>List every command, grouped by who can run it</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>

        <Title order={3} size="h5" mt="md" mb={4}>
          Referee tier and above
        </Title>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                <Cmd>/dq</Cmd>
              </Table.Td>
              <Table.Td>Disqualify a player, or forfeit them out of this match</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/rule song</Cmd>
              </Table.Td>
              <Table.Td>Rule on the song in play</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/rule set</Cmd>
              </Table.Td>
              <Table.Td>Rule on the set's overall outcome, even if songs are left unplayed</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>

        <Title order={3} size="h5" mt="md" mb={4}>
          Tournament Organizer tier and above
        </Title>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament create</Cmd>
              </Table.Td>
              <Table.Td>Create a new tournament in this server</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament open-registration</Cmd>
              </Table.Td>
              <Table.Td>Open registration so /join starts working</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament close-registration</Cmd>
              </Table.Td>
              <Table.Td>Close registration so /join stops working</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament open-checkin</Cmd>
              </Table.Td>
              <Table.Td>Open check-in and notify registered players</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament close-checkin</Cmd>
              </Table.Td>
              <Table.Td>Close check-in and normalize seeds</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament start</Cmd>
              </Table.Td>
              <Table.Td>Start the tournament: build the bracket and set up threads</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament cancel</Cmd>
              </Table.Td>
              <Table.Td>Cancel the tournament</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/tournament rename</Cmd>
              </Table.Td>
              <Table.Td>Rename the tournament this server is holding</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/roster add</Cmd>
              </Table.Td>
              <Table.Td>Register a player who missed registration</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/roster checkin</Cmd>
              </Table.Td>
              <Table.Td>Check a player in on their behalf</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/roster uncheckin</Cmd>
              </Table.Td>
              <Table.Td>Undo a player's check-in</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/roster remove</Cmd>
              </Table.Td>
              <Table.Td>Withdraw a player from the tournament</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>

        <Title order={3} size="h5" mt="md" mb={4}>
          Manage Server permission (Discord, not a bot tier)
        </Title>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                <Cmd>/setup channels</Cmd>
              </Table.Td>
              <Table.Td>Point the bot at (or create) the matches/alerts/results/general channels</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/setup roles</Cmd>
              </Table.Td>
              <Table.Td>Point the bot at (or create) the referee/organizer tier roles</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <Cmd>/setup status</Cmd>
              </Table.Td>
              <Table.Td>Re-run the setup diagnostic</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </div>

      <div>
        <Title order={2} id="faq">
          FAQ
        </Title>
        <Accordion variant="separated" mt="xs">
          <Accordion.Item value="checkin-order">
            <Accordion.Control>Why won't check-in open?</Accordion.Control>
            <Accordion.Panel>
              Registration has to be closed first. Run <Cmd>/tournament close-registration</Cmd>, then{' '}
              <Cmd>/tournament open-checkin</Cmd>. Phases only move forward one step at a time — see{' '}
              <Anchor href="#phases">Tournament phases</Anchor> — and the bot's error names the phase it expected if you try to
              skip one.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="signin">
            <Accordion.Control>Do I have to sign in?</Accordion.Control>
            <Accordion.Panel>
              No. Every bracket, match, and pack page is public, and every action works from Discord alone: registering,
              checking in, refereeing, even running the whole tournament lifecycle. Signing in only adds the homepage's "servers
              you manage" list and a personal dashboard.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="perms">
            <Accordion.Control>What Discord permissions does the bot need?</Accordion.Control>
            <Accordion.Panel>
              View Channel, Send Messages, Send Messages in Threads, Create Private Threads, Manage Threads, Embed Links, and
              Read Message History in the matches, alerts, and results channels. <Code>Manage Channels</Code> and{' '}
              <Code>Manage Roles</Code> are optional. They let setup create channels/roles for you and repair permission gaps;
              without them, setup falls back to pointing at things you create yourself, plus a diagnostic telling you what's
              missing.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="one-role">
            <Accordion.Control>Can one role do everything?</Accordion.Control>
            <Accordion.Panel>
              Yes. Point both the Referee and Tournament Organizer slots at the same Discord role in setup, and that role gets
              full authority over both refereeing and running the tournament lifecycle.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="stall">
            <Accordion.Control>What happens if a match stalls?</Accordion.Control>
            <Accordion.Panel>
              The bot never decides on its own. If the players disagree, a photo is missing, or someone's gone quiet, the match
              just waits until someone at Referee tier or above steps in from the organizer alert channel, the Organizer
              Console, or <Cmd>/rule</Cmd>/<Cmd>/dq</Cmd>.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="cancel">
            <Accordion.Control>Can I cancel a tournament?</Accordion.Control>
            <Accordion.Panel>
              Yes, even mid-event. <Cmd>/tournament cancel</Cmd> ends every match still in progress, announces the cancellation,
              and frees the server's tournament slot. Any match already finished keeps its real result.
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="delete">
            <Accordion.Control>Are past tournaments deleted?</Accordion.Control>
            <Accordion.Panel>
              No. A finished tournament's page stays at the same URL forever, unchanged from how it looked when it ended. Old
              links to it, from Discord or anywhere else, keep working.
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </div>
    </Stack>
  );
}
