// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// telegram
import { TELEGRAM_BOT_TOKEN } from '../config.js';
import { TelegramChannel } from './telegram.js';
import { registerChannel } from './registry.js';

if (TELEGRAM_BOT_TOKEN) {
  registerChannel(
    'telegram',
    (opts) => new TelegramChannel(TELEGRAM_BOT_TOKEN, opts),
  );
}

// whatsapp
