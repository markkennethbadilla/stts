// stt and tts tools over stdio. Schemas and descriptions come from protocol.ts.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { request } from './client.ts';
import { STT_DESCRIPTION, sttShape, TTS_DESCRIPTION, ttsShape } from './protocol.ts';

export const server = new McpServer({ name: 'stts-mcp', version: '1.0.0' });

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });

server.registerTool('stt', { description: STT_DESCRIPTION, inputSchema: sttShape }, async (a) =>
  reply(await request({ kind: 'stt', who: 'session', ...a })),
);

server.registerTool('tts', { description: TTS_DESCRIPTION, inputSchema: ttsShape }, async (a) =>
  reply(await request({ kind: 'tts', who: 'session', ...a })),
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
