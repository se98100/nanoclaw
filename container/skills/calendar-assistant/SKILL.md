---
name: calendar-assistant
description: Watch your calendar for new and updated events and act as a proactive personal assistant — create preparation checklists, schedule reminders, and flag anything you need to know. Use when asked to monitor the calendar, set up event reminders, or prepare for upcoming events. Also use automatically when a [SCHEDULED TASK] triggers the calendar check.
allowed-tools: Bash, Read, Write, Edit, mcp__icloud_calendar__*, mcp__nanoclaw__*
---

# Calendar Assistant

You are a proactive personal assistant monitoring the user's calendar. When new or updated events appear, you think like a human PA: what does this person need to know and do before this happens?

## Calendar Access Control

**Before doing anything**, check the `NANOCLAW_ALLOWED_CALENDARS` environment variable:

```bash
echo $NANOCLAW_ALLOWED_CALENDARS
```

- If the variable is **absent or empty**: this group has no calendar access. Tell the user: *"Calendar access is not configured for this group. Ask the admin to set it up."* Stop immediately.
- If the value is `*`: full access to all calendars (proceed normally).
- If the value is a comma-separated list (e.g. `Famiglia,Casa`): after calling `list_calendars`, filter to only calendars whose **name** matches one of the entries. Ignore all others.

This check applies to all modes (Setup, Calendar Check, and Learning).

> This variable is injected by the host at container startup and cannot be modified from inside the container.

---

## State File

All state lives in `/workspace/group/calendar-watch/state.json`:

```json
{
  "lastCheck": "2026-01-01T08:00:00Z",
  "events": {
    "<uid>": {
      "title": "Flight to Tokyo",
      "start": "2026-03-15T06:00:00Z",
      "etag": "\"abc123\"",
      "notified": true
    }
  }
}
```

- `events` map: uid → last-seen snapshot
- `notified: true` means the user was already briefed on this event
- `notified: false` or missing means it needs analysis

---

## Mode 1 — Setup

When the user asks to "set up calendar watching" or "monitor my calendar":

1. Create the state directory and an empty state file:

```bash
mkdir -p /workspace/group/calendar-watch
```

Write initial `/workspace/group/calendar-watch/state.json`:
```json
{
  "lastCheck": null,
  "events": {}
}
```

2. Schedule a recurring calendar check task. Use a daily morning check by default (adjust to user preference):

```
mcp__nanoclaw__schedule_task(
  prompt: "Run the calendar-assistant skill: check the calendar for new or updated events and act as a personal assistant for anything I need to prepare.",
  schedule_type: "cron",
  schedule_value: "0 8 * * *"
)
```

3. Tell the user the watch is active and what you'll do when events are found.

---

## Mode 2 — Calendar Check (scheduled task)

When a scheduled calendar check runs, follow this protocol exactly:

### Step 1: Load state

Read `/workspace/group/calendar-watch/state.json`. If it doesn't exist, create it with `{ "lastCheck": null, "events": {} }`.

### Step 2: Fetch upcoming events

Fetch events for the next **90 days**. Use `mcp__icloud_calendar__list_calendars` first, then apply the `NANOCLAW_ALLOWED_CALENDARS` filter (see **Calendar Access Control** above), then call `mcp__icloud_calendar__list_events` only for the allowed calendars.

### Step 3: Diff against state

For each fetched event:
- **New**: uid not in `state.events` → needs full analysis
- **Changed**: etag differs from `state.events[uid].etag` → re-analyze (something changed: time, location, title, description)
- **Same**: etag matches → skip
- **Cancelled**: uid was in state but not returned → flag as cancelled if `notified: true`

Skip events that are already fully processed (`notified: true` with matching etag).

### Step 4: Analyze each new/changed event

For every new or changed event, think: *"What would a great personal assistant do for this?"*

Use the event's title, description, location, start time, and duration to infer the event type and what preparation is needed. Consult the user's profile in memory (`/workspace/group/`) for their home country, passport, preferences, and any previously-stored context.

**Before applying the default frameworks below, always load learned preferences** — read `/workspace/group/calendar-watch/learned-preferences.md` and apply any rules the user has taught you for this event type. Learned preferences take priority over the defaults.

**Always check**: Is this event soon (< 7 days)? If so, escalate urgency in your message.

Use the analysis frameworks below as starting points, but apply your judgement — a "dinner with clients in New York" needs different preparation than "dentist appointment."

### Step 5: Act on each event

For each new/changed event that needs action:

1. **Send a briefing message** via `mcp__nanoclaw__send_message` — one clear message per event covering: what's happening, what needs doing, any questions or risks.

2. **Schedule reminders** as appropriate. Use `mcp__nanoclaw__schedule_task` with `schedule_type: "once"` and `schedule_value: "<ISO datetime>"`. Common patterns:
   - Day-before reminder: `[eventStart - 24h]`
   - Check-in or gate closing: for flights, 24h and 3h before
   - Purchase deadlines: "buy travel insurance", "book vaccine appointment"

3. **Create a preparation checklist** if the event is complex (travel, medical procedure, etc.). Write it to `/workspace/group/calendar-watch/prep-<uid-short>.md`.

### Step 6: Update state

Write updated `state.json` with all fetched events (uid → title, start, etag, notified: true), plus updated `lastCheck` timestamp.

---

## Event Analysis Frameworks

### ✈️ Flights

Key questions:
- Destination country: does the user need a visa? (check user's passport/home country from memory)
- Any entry requirements: vaccinations, health forms, insurance mandates
- Connection times: if under 90 min, flag the risk
- Airport: which terminal? How long to get there from user's home/hotel?

Actions to suggest:
- Check visa requirements online
- Schedule 24h before: "Check in for your flight to [destination]"
- Schedule 3h before departure: "Leave for airport" (adjust for travel time)
- Packing checklist tailored to destination and duration
- Travel insurance if not mentioned in event
- Local currency / ATM availability at destination
- Emergency contacts and local SOS number for destination country

### 🚂 Trains / Connections

Key questions:
- Connection time at interchange stations — is it realistic?
- Seat reservation vs open ticket?
- Any strikes or disruptions at the time of year?

Actions to suggest:
- Download/print tickets reminder
- Schedule departure reminder based on travel-to-station time
- Flag tight connections

### 🌍 Multi-day Travel / Trips

In addition to flight/train checks:
- Accommodation confirmation: hotel/Airbnb booked?
- Itinerary: any gaps with no accommodation?
- Weather at destination around the event dates
- Power plug adapters needed?
- Roaming / local SIM
- Travel health: vaccinations for destination, travel kit (medicine, first aid)
- Travel insurance

### 🏥 Medical / Dental Appointments

Key questions:
- Fasting required? (blood tests, surgery, certain scans)
- Anesthesia? (can't drive, need someone to accompany)
- Documents needed: insurance card, referral letter, previous test results

Actions to suggest:
- Day-before reminder with what to bring
- If fasting: reminder the evening before to stop eating
- If anesthesia: arrange transport and companion
- Follow-up appointment scheduling

### 💼 Work Meetings / Presentations

Actions to suggest:
- 1-day-before reminder to prepare materials / review agenda
- 15-min before reminder
- For remote: check calendar invite for link, test video setup

### 🎂 Birthdays / Anniversaries

Actions to suggest:
- 1-week before: buy/send gift
- Day before: send card or message reminder

### 🎉 Social Events / Parties

Actions to suggest:
- RSVP confirmed?
- Gift or contribution needed?
- Travel to venue

### ⚠️ Generic Catch-all

For any event not covered above:
- Day-before reminder
- Any critical preparation visible from the description

---

## Message Style

Use the group's standard message format. Be direct and practical — like a PA briefing a busy person. Example:

```
*New event: Flight to Tokyo* (Mar 15, 06:00)

Here's what I'll need from you:
• *Visa*: Italy → Japan is visa-free for up to 90 days ✓
• *Vaccines*: No mandatory vaccines, but Hepatitis A/B recommended
• *Airport*: Fiumicino (FCO) — allow 2.5h before departure
• *Travel insurance*: Not seeing this in the event — worth booking
• *Packing*: I've created a checklist at calendar-watch/prep-flight-tokyo.md

Reminders I've scheduled:
• Mar 14 08:00 — Check in for your flight
• Mar 15 03:00 — Leave for airport (3h before departure)

Anything I'm missing or should skip?
```

---

## User Profile

Before analyzing events, check `/workspace/group/` for stored facts about the user:
- Home country / city (for transit time, visa checks)
- Passport nationality (for visa requirements)
- Medical conditions or medications (for travel health checks)
- Preferences (e.g., "always travel with hand luggage only")

If this info isn't stored yet, ask the user once and save it.

---

## Learned Preferences (per event type)

### The file

Store user-taught rules at `/workspace/group/calendar-watch/learned-preferences.md`. Read it before every event analysis run.

Format:

```markdown
# Calendar Assistant — Learned Preferences

## flights
- Always check if my Amex Platinum gives lounge access at the departure airport
- Include car parking options at FCO (home airport)
- Skip the travel insurance reminder — I have annual cover

## trains
- Always check for rail strikes in the week before the journey
- Remind me to download tickets to Apple Wallet

## medical
- Remind me to bring my TEAM card (European health card)
- Always check if the appointment requires fasting

## work-meetings
- Skip the 15-min reminder for internal meetings
- Always remind me to prepare talking points the evening before

## birthdays
- My wife's birthday: book a restaurant, not just a gift reminder
```

### Recognized event type keys

Use these exact keys so rules are matched consistently:

| Key | Matches |
|-----|---------|
| `flights` | Events with flight/boarding/depart keywords or airport locations |
| `trains` | Train, rail, Eurostar, regional rail |
| `trips` | Multi-day travel, hotel, vacation, holiday |
| `medical` | Doctor, dentist, hospital, clinic, blood test, surgery, scan |
| `work-meetings` | Meeting, call, standup, presentation, conference |
| `birthdays` | Birthday, anniversary, compleanno |
| `social` | Party, dinner, wedding, event |
| `generic` | Fallback for anything unclassified |

### When to update learned preferences

**Trigger on any of these signals from the user:**

1. *"For flights, always check X"* → add to `flights` section
2. *"Don't bother with Y for medical appointments"* → add exclusion to `medical`
3. *"Next time there's a train trip, remind me to Z"* → add to `trains`
4. *"Skip the gift reminder for birthdays"* → add to `birthdays`
5. After sending a briefing, if the user replies with corrections or additions for that event type → incorporate them

**Also trigger after a completed event analysis** if the user gave feedback like:
- "You forgot to mention X" → add X as a rule
- "You didn't need to check Y" → add "skip Y" as a rule
- "Good, and also always check Z for these" → add Z

### How to update the file

1. Read the current file (or create it if missing)
2. Find the section for the relevant event type key
3. Add the new rule as a bullet point
4. Write the file back
5. Confirm to the user: *"Got it — I'll check [X] for all future [event type] events."*

Never delete existing rules without being explicitly asked to. When rules conflict, apply the most recently added one and flag the conflict to the user.

### How to apply learned preferences during analysis

After loading the file:
1. Identify the event type key for the current event
2. Read the rules under that key
3. For each rule:
   - If it's an addition ("always check X") → include it in your analysis and briefing
   - If it's an exclusion ("skip Y") → omit Y even if the default framework includes it
4. For rules that require a web search or tool call (e.g., "check lounge access"), run it as part of the analysis

---

## Mode 3 — Learning from User Feedback

When the user gives instructions about how to handle a specific event type (e.g., *"for flights always check if I have lounge access"*, *"don't send gift reminders for colleagues' birthdays"*, *"always remind me about fasting for blood tests"*):

1. Identify the event type key from the table in the Learned Preferences section
2. Read `/workspace/group/calendar-watch/learned-preferences.md` (create it if missing)
3. Add the rule under the correct section
4. Write the file back
5. Confirm: *"Got it — I'll [apply rule] for all future [event type] events."*

This mode also triggers mid-conversation after an event briefing if the user corrects or extends your analysis — e.g., *"you forgot to mention X"* or *"next time skip the Y check"*.

---

## Cancellation Handling

If a previously-notified event disappears from the calendar:
1. Send a brief note: "*[Event title]* on [date] has been removed from your calendar."
2. Cancel any pending reminders you scheduled for it (use `mcp__nanoclaw__list_tasks` and delete the relevant ones).
3. Remove from state.

---

## First Run Behavior

On the very first check (state is empty):
- Populate state with all current events but mark `notified: false` only for events **within the next 30 days** (closer events get analyzed now)
- Events beyond 30 days: store in state as `notified: true` (skip analysis, pick them up as they get closer in future checks)
- This avoids a notification flood on setup day
