// The page machine emits the exact lines the daemon logs as "page mic start" and
// "page mic restart #N: reason".
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { attachPage, deps } from '../../src/daemon.ts';
import { pageMachine } from '../../web/machine';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it('mic start and mic restart #N: reason reach daemon.log word for word', () => {
  const logged: string[] = [];
  deps.log = (l) => void logged.push(l);
  const link = attachPage(() => {});
  const actor = createActor(
    pageMachine.provide({ actions: { log: (_, { line }) => link.onMessage(JSON.stringify({ type: 'log', line })) } }),
  ).start();
  actor.send({ type: 'REQUEST', kind: 'listen' });
  actor.send({ type: 'MIC_STARTED' });
  actor.send({ type: 'MIC_ERROR' });
  vi.advanceTimersByTime(0);
  actor.send({ type: 'MIC_STARTED' });
  vi.advanceTimersByTime(16_000);
  expect(logged.slice(0, 4)).toEqual([
    'page mic start',
    'page mic restart #1: mic error',
    'page mic start',
    'page mic restart #2: no audio or words for 15s during a listen',
  ]);
  link.detach();
});
