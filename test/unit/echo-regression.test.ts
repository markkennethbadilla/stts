// 2026-10-07: right after the swap to Chrome's own capture, the agent's reply came back garbled as turn 1.
import { expect, it } from 'vitest';
import { isEcho } from '../../web/machine';

it('a garbled echo of the last reply is recognised as echo', () => {
  const spoken = ['That is live now, no dropped-speech restarts since. Tell me if anything still gets cut off.'];
  expect(isEcho('Their healthy new job speech to start since tell me your and still get all', spoken)).toBe(true);
});
