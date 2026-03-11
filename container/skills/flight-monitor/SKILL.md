---
name: flight-monitor
description: Monitor flights using FlightRadar24. Track real-time status, delays, gate changes, and arrival times for specific flights. Use when asked to track a flight, monitor flight status, watch a flight, or set up flight alerts. Also use when a [SCHEDULED TASK] triggers a flight status check.
allowed-tools: Bash, Read, Write, Edit, mcp__nanoclaw__*
---

# Flight Monitor

Track specific flights via FlightRadar24 and notify the user of status changes (delays, gate changes, departure, cancellation). Monitoring stops automatically when the flight departs — you'll be on the plane anyway.

## State File

All state lives in `/workspace/group/flight-watch/state.json`:

```json
{
  "flights": {
    "LH123-2026-03-15": {
      "flightNumber": "LH123",
      "date": "2026-03-15",
      "origin": "FRA",
      "destination": "JFK",
      "scheduledDeparture": "2026-03-15T10:00:00Z",
      "scheduledArrival": "2026-03-15T13:30:00Z",
      "lastStatus": "scheduled",
      "lastActualDeparture": null,
      "lastActualArrival": null,
      "lastDelayMinutes": 0,
      "lastGate": null,
      "lastChecked": "2026-03-15T08:00:00Z",
      "notifiedEvents": []
    }
  }
}
```

- `lastStatus`: one of `scheduled`, `active`, `landed`, `cancelled`, `diverted`, `unknown`
- `notifiedEvents`: list of event strings already sent (e.g. `"departed"`, `"landed"`, `"delay-30"`, `"gate-B12"`) — prevents duplicate notifications
- `scheduledDeparture` / `scheduledArrival`: ISO UTC strings; null if unknown

---

## Python Setup

Install the FlightRadar24 library once before running checks:

```bash
pip install FlightRadarAPI -q 2>&1 | grep -v "^$" | tail -3
```

Then use inline Python to query flight data:

```python
from FlightRadar24 import FlightRadar24API
from datetime import datetime, timezone
import json, sys

fr = FlightRadar24API()

flight_number = "LH123"   # IATA format, e.g. "LH123", "BA456"

# Convert IATA airline prefix to ICAO (first 2 chars → ICAO lookup via API)
airlines = fr.get_airlines()
# Airlines list: [{ICAO: "DLH", IATA: "LH", Name: "Lufthansa"}, ...]
iata_prefix = ''.join(filter(str.isalpha, flight_number))
icao_code = next((a["ICAO"] for a in airlines if a.get("IATA") == iata_prefix), None)

if not icao_code:
    print(json.dumps({"error": f"Unknown airline IATA code: {iata_prefix}"}))
    sys.exit(1)

# Get all currently airborne flights for this airline
flights = fr.get_flights(airline_icao=icao_code)

# Match by flight number (FlightRadar24 callsign is ICAO + number, e.g. "DLH123")
number_part = flight_number[len(iata_prefix):]
icao_callsign = icao_code + number_part

match = next((f for f in flights if f.callsign == icao_callsign), None)

def ts_to_utc(ts):
    """Convert a Unix timestamp (int) to a UTC ISO 8601 string, or None."""
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()

if match:
    details = fr.get_flight_details(match)
    match.set_flight_details(details)
    times = details.get("time", {})
    result = {
        "status": "active",
        "origin": match.origin_airport_iata,
        "destination": match.destination_airport_iata,
        "altitude": match.altitude,
        "speed": match.ground_speed,
        "scheduledDeparture": ts_to_utc(times.get("scheduled", {}).get("departure")),
        "scheduledArrival":   ts_to_utc(times.get("scheduled", {}).get("arrival")),
        "actualDeparture":    ts_to_utc(times.get("real", {}).get("departure")),
        "estimatedArrival":   ts_to_utc(times.get("estimated", {}).get("arrival")),
        "delayMinutes": times.get("other", {}).get("delay"),
        "status_text": details.get("status", {}).get("text"),
        "aircraftReg": match.registration,
    }
else:
    # Flight not yet airborne — still on the ground or not yet in FR24
    result = {"status": "not_airborne", "flights_checked": len(flights)}

print(json.dumps(result))
```

> **Tip**: If the airline ICAO→IATA mapping fails for a code, try searching `fr.get_airlines()` for the `Name` field and pick the closest match. Some regional carriers have non-obvious mappings.

### Timezone note

All times stored in state and passed to `schedule_task` must be **UTC ISO 8601** strings (e.g. `2026-03-15T08:00:00+00:00`). FlightRadar24 returns Unix timestamps — always convert with `ts_to_utc()` above, never with `datetime.now()` (which uses the local timezone). When displaying times to the user, format them in local time using the `TZ` env var:

```python
import os
local_tz_name = os.environ.get("TZ", "UTC")
# Use zoneinfo (Python 3.9+) for display-only formatting:
from zoneinfo import ZoneInfo
local_tz = ZoneInfo(local_tz_name)
local_time = datetime.fromtimestamp(int(ts), tz=local_tz).strftime("%b %d, %H:%M")
```

When computing "next check time" for `schedule_value`, always produce a UTC ISO string:
```python
from datetime import timedelta
next_check_utc = (datetime.now(tz=timezone.utc) + timedelta(minutes=30)).isoformat()
```

---

## Mode 1 — Add a Flight to Monitor

When the user asks to track a flight (e.g. "track LH123 on March 15" or "monitor my flight BA456 tomorrow"):

### Step 1: Parse the request

Extract:
- **Flight number** (IATA format, e.g. `LH123`)
- **Date** (YYYY-MM-DD) — if not given, assume today or ask

### Step 2: Do an initial status check

Run the Python lookup above immediately to validate the flight exists and get baseline data. If the flight can't be found yet (it's far in the future), initialize state with the info provided.

### Step 3: Initialize state

Read (or create) `/workspace/group/flight-watch/state.json`. Add the flight entry under key `"{flightNumber}-{date}"`.

```bash
mkdir -p /workspace/group/flight-watch
```

### Step 4: Schedule monitoring

Schedule the first check now, and then chain checks from within each run (see Mode 2 for the re-scheduling logic):

```
mcp__nanoclaw__schedule_task(
  prompt: "Run the flight-monitor skill: check status of flight LH123 on 2026-03-15 and notify of any changes.",
  schedule_type: "once",
  schedule_value: "<next check ISO datetime>"
)
```

**Initial check interval** based on time until departure:
| Time to departure | Check interval |
|---|---|
| > 24h | 6 hours |
| 6–24h | 2 hours |
| 2–6h | 30 minutes |
| < 2h | 15 minutes |
| Departed / cancelled | Stop — no further checks |

Store the scheduled task ID if returned by the MCP tool, in case the user wants to cancel monitoring later.

### Step 5: Confirm to user

```
*Flight LH123 — Frankfurt → New York JFK* (Mar 15, 10:00 local)
Monitoring is active. I'll alert you for:
• Delays or gate changes
• Departure confirmation

Monitoring stops automatically when the flight departs.
Next check: in 2 hours.
```

---

## Mode 2 — Flight Status Check (Scheduled Task)

When a scheduled check runs, follow this protocol:

### Step 1: Load state

Read `/workspace/group/flight-watch/state.json`. Find the entry for the flight being checked.

### Step 2: Run the status check

Execute the Python snippet above and capture the JSON result.

### Step 3: Detect changes and send notifications

Compare result against stored state. For each change, check if it's already in `notifiedEvents` — if not, send a notification and add it.

**Notification triggers:**

| Event | Condition | Action after notify |
|---|---|---|
| **Delay** | `delayMinutes` increased by ≥ 15 vs stored | Continue monitoring |
| **Gate change** | `gate` differs from stored `lastGate` | Continue monitoring |
| **Departed** | `status` changed to `active` | **Stop monitoring** |
| **Cancelled** | `status` changed to `cancelled` | **Stop monitoring** |

Use `mcp__nanoclaw__send_message` for each notification. Keep messages brief and factual. All times shown to the user should be **local time** (use the `TZ` env var for formatting — see timezone note above).

**Example messages:**
```
✈️ *LH123 has departed* Frankfurt on time (10:04 local). Have a good flight!

⚠️ *LH123 is delayed* — new departure: 11:45 local (+45 min).

⚠️ *Gate change* — LH123 is now departing from Gate B14.

❌ *LH123 has been cancelled.* Check with the airline for rebooking options.
```

### Step 4: Update state

Write updated state: `lastStatus`, `lastDelayMinutes`, `lastGate`, `lastActualDeparture`, `lastChecked`, and add any sent events to `notifiedEvents`.

### Step 5: Schedule next check (or stop)

**If the flight has departed (`active`) or been cancelled**: do **not** schedule another check. Update state to mark monitoring as complete. You're done.

**Otherwise**, schedule the next check using a UTC ISO datetime for `schedule_value`:

```
mcp__nanoclaw__schedule_task(
  prompt: "Run the flight-monitor skill: check status of flight LH123 on 2026-03-15 and notify of any changes.",
  schedule_type: "once",
  schedule_value: "<UTC ISO datetime, e.g. 2026-03-15T09:30:00+00:00>"
)
```

Use the interval table from Mode 1. Base the next check time on **current UTC time** (`datetime.now(tz=timezone.utc) + timedelta(...)`) — never on local time or scheduled departure time.

---

## Mode 3 — List Tracked Flights

When the user asks "what flights are you tracking?" or "show my monitored flights":

Read state and list active flights (those without `active`/`cancelled` status, i.e. still pre-departure):

```
*Tracked flights:*
• LH123 — FRA → JFK — Mar 15, 10:00 — Status: scheduled
• BA456 — LHR → MAD — Mar 18, 14:20 — Status: scheduled
```

---

## Mode 4 — Stop Tracking a Flight

When the user says "stop tracking LH123" or "cancel monitoring for my March 15 flight":

1. Read state, find the matching flight entry
2. Use `mcp__nanoclaw__list_tasks` to find the scheduled check task (match by prompt content)
3. Delete the task using `mcp__nanoclaw__delete_task`
4. Remove the flight entry from state (or mark it as `cancelled_by_user`)
5. Confirm: *"Stopped monitoring LH123 on March 15."*

---

## Handling Edge Cases

**Flight not found in FlightRadar24:**
- If the flight is > 2 days out, it may not be in the system yet — that's normal. Store what the user told you and check again closer to departure.
- If within 24h and still not found, notify the user: *"I can't find LH123 on FlightRadar24 — it may not have a live tracking entry yet. I'll keep checking."*

**ICAO code lookup fails:**
- Try searching `fr.get_airlines()` by name substring match
- Or ask the user for the full airline name

**Python/network errors:**
- Log the error to state (`lastError`)
- Schedule a retry in 30 minutes
- Notify user only if 3 consecutive checks fail

**Multiple flights with same number (codeshares):**
- FlightRadar24 shows the operating carrier. If the user has a codeshare ticket (e.g. AA on a BA metal), try both airline codes.

---

## Message Style

Brief, factual, no fluff. Use emoji sparingly for quick scanning:
- ✈️ Departure
- 🛬 Landing
- ⚠️ Delay or gate change
- ❌ Cancellation
- 🔀 Diversion

Always include the scheduled vs actual time when there's a change.
