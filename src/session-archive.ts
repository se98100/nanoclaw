/**
 * Host-side session archival.
 * Reads a Claude SDK JSONL session transcript and writes it as a markdown
 * conversation archive to the group's conversations/ directory.
 * Called before rotating to a new session (day change).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

function formatMarkdown(
  messages: ParsedMessage[],
  assistantName: string,
  date: string,
): string {
  const lines: string[] = [];
  lines.push(`# Conversation — ${date}`);
  lines.push('');
  lines.push(`Archived: ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName;
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Archive a session transcript to the group's conversations/ directory.
 * Returns true if something was archived, false if nothing to archive.
 */
export function archiveSession(
  groupFolder: string,
  sessionId: string,
  assistantName: string,
  sessionDate?: string | null,
): boolean {
  const jsonlPath = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );

  if (!fs.existsSync(jsonlPath)) {
    logger.debug({ groupFolder, sessionId }, 'No JSONL found for session, skipping archive');
    return false;
  }

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    logger.warn({ groupFolder, sessionId, err }, 'Failed to read session JSONL');
    return false;
  }

  const messages = parseTranscript(content);
  if (messages.length === 0) {
    logger.debug({ groupFolder, sessionId }, 'Session transcript is empty, skipping archive');
    return false;
  }

  const date = sessionDate || new Date().toISOString().split('T')[0];
  const conversationsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  // Generate unique filename — avoid collisions if multiple sessions same day
  const time = new Date().toTimeString().slice(0, 5).replace(':', '');
  const filename = `${date}-conversation-${time}.md`;
  const filePath = path.join(conversationsDir, filename);

  try {
    fs.writeFileSync(filePath, formatMarkdown(messages, assistantName, date));
    logger.info({ groupFolder, sessionId, filePath }, 'Session archived');
    return true;
  } catch (err) {
    logger.warn({ groupFolder, sessionId, err }, 'Failed to write conversation archive');
    return false;
  }
}
