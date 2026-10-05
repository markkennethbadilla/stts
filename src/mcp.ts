// T4 fills this in: stt and tts tools over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const server = new McpServer({ name: 'stts-mcp', version: '1.0.0' });
