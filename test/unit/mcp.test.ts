import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as p from '../../src/protocol.ts';
import fixture from '../fixtures/old-contract.json' with { type: 'json' };

const request = vi.fn(async (_body: unknown) => 'heard');
vi.mock('../../src/client.ts', () => ({ request: (b: unknown) => request(b) }));

const { server } = await import('../../src/mcp.ts');
const client = new Client({ name: 't', version: '0' });

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe('mcp tools', () => {
  it('lists stt and tts with zod schemas and the old descriptions', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(['stt', 'tts']);
    expect(by['stt']?.description).toBe(fixture.sttDescription);
    expect(by['tts']?.description).toBe(fixture.ttsDescription);
    for (const [name, shape] of [
      ['stt', p.sttShape],
      ['tts', p.ttsShape],
    ] as const) {
      const want = z.toJSONSchema(z.object(shape)) as { properties: object };
      expect(by[name]?.inputSchema.properties).toEqual(want.properties);
    }
    for (const t of tools) {
      for (const s of Object.values(fixture.sentinels).filter((s) => s !== p.STOPPED))
        expect(t.description).toContain(s);
      for (const n of Object.values(fixture.notes)) expect(t.description).toContain(n);
    }
  });

  it('forwards a call to the daemon as a request body', async () => {
    const r = await client.callTool({ name: 'tts', arguments: { text: 'hi', listen: true } });
    expect(request).toHaveBeenLastCalledWith({ kind: 'tts', who: 'session', text: 'hi', listen: true });
    expect(r.content).toEqual([{ type: 'text', text: 'heard' }]);
  });

  it('refuses out-of-range input before it reaches the daemon', async () => {
    request.mockClear();
    const r = await client.callTool({ name: 'stt', arguments: { idleSec: 999 } });
    expect(r.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('STTS_WHO', () => {
  it('agent marks every call who=agent; unset is session', async () => {
    vi.resetModules();
    process.env['STTS_WHO'] = 'agent';
    const { server: s2 } = await import('../../src/mcp.ts');
    delete process.env['STTS_WHO'];
    const c2 = new Client({ name: 't2', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([s2.connect(a), c2.connect(b)]);
    await c2.callTool({ name: 'tts', arguments: { text: 'bye', close: true } });
    expect(request).toHaveBeenLastCalledWith({ kind: 'tts', who: 'agent', text: 'bye', close: true });
    // The gateway path: stt keeps idleSec as given.
    await c2.callTool({ name: 'stt', arguments: { idleSec: 5 } });
    expect(request).toHaveBeenLastCalledWith({ kind: 'stt', who: 'agent', idleSec: 5 });
  });
});
