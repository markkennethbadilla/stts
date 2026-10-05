// stt and tts tools over stdio. Schemas and descriptions come from protocol.ts.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { request } from './client.ts';
import { STT_DESCRIPTION, sttShape, TTS_DESCRIPTION, ttsShape } from './protocol.ts';

export const server = new McpServer({ name: 'stts-mcp', version: '1.0.0' });

// STTS_WHO=agent (the gateway entry) marks a helper agent, whose close is ignored; the plugin sets nothing.
const who = process.env['STTS_WHO'] === 'agent' ? 'agent' : 'session';
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

server.registerTool('stt', { description: STT_DESCRIPTION, inputSchema: sttShape }, async (a) =>
  reply(await request({ kind: 'stt', who, ...a })),
);

server.registerTool('tts', { description: TTS_DESCRIPTION, inputSchema: ttsShape }, async (a) =>
  reply(await request({ kind: 'tts', who, ...a })),
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
