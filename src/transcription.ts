/**
 * Voice message transcription using Groq Whisper API.
 * Reads GROQ_API_KEY from .env. No extra packages needed — uses fetch + FormData.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let _apiKey: string | null = null;

function getApiKey(): string | null {
  if (_apiKey) return _apiKey;
  const secrets = readEnvFile(['GROQ_API_KEY']);
  _apiKey = secrets.GROQ_API_KEY || null;
  return _apiKey;
}

/**
 * Transcribe an audio buffer using Groq Whisper large-v3-turbo.
 * @param audioBuffer - Raw audio bytes (OGG/OPUS from Telegram)
 * @param mimeType - MIME type (default: audio/ogg)
 * @returns Transcript string, or null on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType = 'audio/ogg',
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('GROQ_API_KEY not set — voice transcription unavailable');
    return null;
  }

  try {
    // Derive a filename extension from MIME type for Groq to detect the format
    const ext = mimeType.split('/')[1]?.split(';')[0] || 'ogg';
    const filename = `voice.${ext}`;

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'text');

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error(
        { status: response.status, body: errText },
        'Groq transcription API error',
      );
      return null;
    }

    const transcript = (await response.text()).trim();
    logger.info(
      { chars: transcript.length },
      'Voice message transcribed via Groq',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Groq transcription failed');
    return null;
  }
}
