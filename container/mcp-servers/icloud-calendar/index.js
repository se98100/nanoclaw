/**
 * iCloud Calendar MCP Server for NanoClaw
 * Provides CalDAV-based calendar tools for the main group agent.
 *
 * Required env vars:
 *   ICLOUD_APPLE_ID      - Apple ID email address
 *   ICLOUD_APP_PASSWORD  - App-specific password (generated at appleid.apple.com)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDAVClient } from 'tsdav';
import { z } from 'zod';

const APPLE_ID = process.env.ICLOUD_APPLE_ID;
const APP_PASSWORD = process.env.ICLOUD_APP_PASSWORD;

if (!APPLE_ID || !APP_PASSWORD) {
  process.stderr.write('[icloud-calendar] ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD must be set\n');
  process.exit(1);
}

// ---------- iCal parsing ----------

function unescapeIcal(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcalDate(value) {
  // Date only: YYYYMMDD
  if (value.length === 8) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  // DateTime: YYYYMMDDTHHmmss[Z]
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${value.endsWith('Z') ? 'Z' : ''}`;
}

function parseVEvents(icalString) {
  const events = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let m;
  while ((m = re.exec(icalString)) !== null) {
    // Unfold RFC 5545 continuation lines
    const lines = m[1].replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const ev = {};
    for (const line of lines) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const propFull = line.slice(0, colon);
      const val = line.slice(colon + 1);
      const propName = propFull.split(';')[0];
      const params = propFull.slice(propName.length);
      switch (propName) {
        case 'UID':         ev.uid = val; break;
        case 'SUMMARY':     ev.title = unescapeIcal(val); break;
        case 'DESCRIPTION': ev.description = unescapeIcal(val); break;
        case 'LOCATION':    ev.location = unescapeIcal(val); break;
        case 'STATUS':      ev.status = val; break;
        case 'DTSTART':
          ev.start = parseIcalDate(val);
          ev.allDay = params.includes('VALUE=DATE') || val.length === 8;
          break;
        case 'DTEND':       ev.end = parseIcalDate(val); break;
      }
    }
    if (ev.uid && ev.start) events.push(ev);
  }
  return events;
}

// ---------- iCal generation ----------

function formatIcalDatetime(iso, allDay = false) {
  if (allDay) return iso.slice(0, 10).replace(/-/g, '');
  return new Date(iso).toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function escapeIcal(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function buildVCalendar({ uid, title, start, end, description, location, allDay }) {
  const stamp = formatIcalDatetime(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//iCloud Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART${allDay ? ';VALUE=DATE' : ''}:${formatIcalDatetime(start, allDay)}`,
    `DTEND${allDay ? ';VALUE=DATE' : ''}:${formatIcalDatetime(end, allDay)}`,
    `SUMMARY:${escapeIcal(title)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeIcal(description)}`);
  if (location)    lines.push(`LOCATION:${escapeIcal(location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------- CalDAV client (lazy, cached) ----------

let _client = null;
let _calendars = null;

async function getClient() {
  if (!_client) {
    _client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: APPLE_ID, password: APP_PASSWORD },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  }
  return _client;
}

async function getCalendars(force = false) {
  const client = await getClient();
  if (!_calendars || force) {
    _calendars = await client.fetchCalendars();
  }
  return _calendars;
}

async function findCalendar(urlOrName) {
  const cals = await getCalendars();
  const found = cals.find(c => c.url === urlOrName || c.displayName === urlOrName);
  if (!found) {
    const names = cals.map(c => `"${c.displayName}" (${c.url})`).join(', ');
    throw new Error(`Calendar "${urlOrName}" not found. Available: ${names}`);
  }
  return found;
}

// ---------- MCP tools ----------

const server = new McpServer({ name: 'icloud_calendar', version: '1.0.0' });

server.tool(
  'list_calendars',
  'List all iCloud calendars with their URLs (needed for other tools)',
  {},
  async () => {
    const cals = await getCalendars(true);
    const result = cals.map(c => ({
      url: c.url,
      name: c.displayName || 'Unnamed',
      description: c.description || '',
      color: c.calendarColor || '',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'list_events',
  'List calendar events within a date range. Use to check schedule, find conflicts, or review upcoming commitments.',
  {
    start_date: z.string().describe('Range start in ISO 8601 (e.g. "2024-03-01" or "2024-03-01T00:00:00Z")'),
    end_date: z.string().describe('Range end in ISO 8601 (e.g. "2024-03-31" or "2024-03-31T23:59:59Z")'),
    calendar_url: z.string().optional().describe('Calendar URL from list_calendars. Omit to search all calendars.'),
  },
  async ({ start_date, end_date, calendar_url }) => {
    const client = await getClient();
    const cals = calendar_url ? [await findCalendar(calendar_url)] : await getCalendars();
    const allEvents = [];
    for (const cal of cals) {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange: {
          start: new Date(start_date).toISOString(),
          end: new Date(end_date).toISOString(),
        },
      });
      for (const obj of objects) {
        if (!obj.data) continue;
        for (const ev of parseVEvents(obj.data)) {
          allEvents.push({
            ...ev,
            calendarName: cal.displayName,
            objectUrl: obj.url,
            etag: obj.etag,
          });
        }
      }
    }
    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return { content: [{ type: 'text', text: JSON.stringify(allEvents, null, 2) }] };
  },
);

server.tool(
  'create_event',
  'Create a new calendar event',
  {
    calendar_url: z.string().describe('Calendar URL from list_calendars'),
    title: z.string().describe('Event title'),
    start: z.string().describe('Start time in ISO 8601 ("2024-03-15T14:00:00Z" or "2024-03-15" for all-day)'),
    end: z.string().describe('End time in ISO 8601 ("2024-03-15T15:00:00Z" or "2024-03-16" for all-day)'),
    description: z.string().optional().describe('Event notes or description'),
    location: z.string().optional().describe('Event location'),
    all_day: z.boolean().optional().describe('All-day event. Auto-detected from date format if omitted.'),
  },
  async ({ calendar_url, title, start, end, description, location, all_day }) => {
    const client = await getClient();
    const cal = await findCalendar(calendar_url);
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@nanoclaw`;
    const allDay = all_day ?? !start.includes('T');
    const ical = buildVCalendar({ uid, title, start, end, description, location, allDay });
    await client.createCalendarObject({ calendar: cal, iCalString: ical, filename: `${uid}.ics` });
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, uid, message: `Event "${title}" created` }) }],
    };
  },
);

server.tool(
  'update_event',
  'Update an existing calendar event. Only provide fields to change.',
  {
    object_url: z.string().describe('objectUrl from list_events'),
    etag: z.string().optional().describe('etag from list_events (prevents overwriting concurrent changes)'),
    title: z.string().optional().describe('New title'),
    start: z.string().optional().describe('New start time in ISO 8601'),
    end: z.string().optional().describe('New end time in ISO 8601'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
  },
  async ({ object_url, etag, ...updates }) => {
    const client = await getClient();
    const cals = await getCalendars();
    let found = null;
    for (const cal of cals) {
      const objs = await client.fetchCalendarObjects({ calendar: cal });
      const obj = objs.find(o => o.url === object_url);
      if (obj) { found = obj; break; }
    }
    if (!found?.data) throw new Error(`Event not found: ${object_url}`);
    const [existing] = parseVEvents(found.data);
    if (!existing) throw new Error(`Could not parse event at ${object_url}`);
    const merged = {
      uid: existing.uid,
      title: updates.title ?? existing.title,
      start: updates.start ?? existing.start,
      end: updates.end ?? existing.end,
      description: updates.description ?? existing.description ?? '',
      location: updates.location ?? existing.location ?? '',
      allDay: existing.allDay,
    };
    const ical = buildVCalendar(merged);
    await client.updateCalendarObject({
      calendarObject: { url: object_url, etag: etag ?? found.etag ?? '', data: found.data },
      iCalString: ical,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Event updated' }) }] };
  },
);

server.tool(
  'delete_event',
  'Delete a calendar event',
  {
    object_url: z.string().describe('objectUrl from list_events'),
    etag: z.string().optional().describe('etag from list_events'),
  },
  async ({ object_url, etag }) => {
    const client = await getClient();
    await client.deleteCalendarObject({ calendarObject: { url: object_url, etag: etag ?? '' } });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Event deleted' }) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
