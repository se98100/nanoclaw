/**
 * Automatically refreshes the Claude Code OAuth access token before it expires.
 *
 * The host Claude Code session normally keeps ~/.claude/.credentials.json fresh,
 * but when running headless (as a systemd service) there is no interactive session
 * to do so. This module polls the credentials file and refreshes the token via
 * the standard OAuth refresh_token grant so containers always receive a valid token.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh the token this many ms before it actually expires. */
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

/** How often to check whether a refresh is needed. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix ms
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

function readCredentials(): ClaudeCredentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8')) as ClaudeCredentials;
  } catch {
    return null;
  }
}

function writeCredentials(creds: ClaudeCredentials): void {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf-8');
}

async function refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  };

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText} – ${body}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any;

  const accessToken: string = data.access_token;
  // expires_in is in seconds; fall back to 8 hours if not provided
  const expiresIn: number = typeof data.expires_in === 'number' ? data.expires_in : 8 * 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  // Some OAuth servers rotate the refresh token on each use — save the new one if provided
  const newRefreshToken: string | undefined = data.refresh_token;

  return { accessToken, refreshToken: newRefreshToken, expiresAt };
}

async function maybeRefresh(): Promise<void> {
  const creds = readCredentials();
  const oauth = creds?.claudeAiOauth;
  if (!oauth) return;

  const msUntilExpiry = oauth.expiresAt - Date.now();
  if (msUntilExpiry > REFRESH_BUFFER_MS) return; // still fresh

  logger.info(
    { expiresAt: new Date(oauth.expiresAt).toISOString() },
    'Claude OAuth token expiring soon, refreshing',
  );

  try {
    const { accessToken, refreshToken: newRefreshToken, expiresAt } = await refreshToken(oauth.refreshToken);
    creds!.claudeAiOauth!.accessToken = accessToken;
    if (newRefreshToken) creds!.claudeAiOauth!.refreshToken = newRefreshToken;
    creds!.claudeAiOauth!.expiresAt = expiresAt;
    writeCredentials(creds!);
    logger.info(
      { expiresAt: new Date(expiresAt).toISOString() },
      'Claude OAuth token refreshed successfully',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to refresh Claude OAuth token');
  }
}

/**
 * Start a background interval that keeps the OAuth token fresh.
 * Runs an immediate check on startup so an already-expired token is
 * refreshed before the first container launch.
 */
export function startTokenRefresher(): void {
  maybeRefresh().catch((err) => logger.error({ err }, 'Initial token refresh check failed'));
  setInterval(() => {
    maybeRefresh().catch((err) => logger.error({ err }, 'Token refresh check failed'));
  }, CHECK_INTERVAL_MS);
}
