/**
 * Image Generation MCP Server for NanoClaw
 * Generates images using Google's Gemini Imagen API and delivers them via IPC.
 *
 * Required env vars:
 *   GEMINI_API_KEY     - Google Gemini API key
 *   NANOCLAW_CHAT_JID  - Set automatically by the agent runner
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const chatJid = process.env.NANOCLAW_CHAT_JID;

if (!GEMINI_API_KEY) {
  process.stderr.write('[image-gen] GEMINI_API_KEY must be set\n');
  process.exit(1);
}

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IMAGES_DIR = path.join(IPC_DIR, 'images');

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({
  name: 'image-gen',
  version: '1.0.0',
});

server.tool(
  'generate_image',
  'Generate an image using Google Gemini Imagen and send it directly to the chat. Use this when the user asks for an image, illustration, or visual.',
  {
    prompt: z.string().describe('Detailed description of the image to generate'),
    aspect_ratio: z
      .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
      .optional()
      .describe('Image aspect ratio (default: 1:1)'),
  },
  async (args) => {
    const aspectRatio = args.aspect_ratio || '1:1';

    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: args.prompt }] }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: {
                aspectRatio,
              },
            },
          }),
        }
      );
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Network error calling Gemini API: ${err.message}` }],
        isError: true,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        content: [{ type: 'text', text: `Gemini API error ${response.status}: ${body}` }],
        isError: true,
      };
    }

    const result = await response.json();
    const parts = result?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart?.inlineData?.data) {
      return {
        content: [{ type: 'text', text: 'Gemini API returned no image data.' }],
        isError: true,
      };
    }

    // Save image to shared IPC images directory
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const ext = imagePart.inlineData.mimeType.split('/')[1] || 'png';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(
      path.join(IMAGES_DIR, filename),
      Buffer.from(imagePart.inlineData.data, 'base64')
    );

    // Queue IPC message to send the image via the host channel
    writeIpcFile(MESSAGES_DIR, {
      type: 'send_image',
      chatJid,
      imageFile: filename,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text', text: `Image generated and sent to chat.` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
