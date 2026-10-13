// 2026-10-07: right after the swap to Chrome's own capture, the agent's reply came back garbled as turn 1.
import { expect, it } from 'vitest';
import { isEcho } from '../../web/machine';

it('a garbled echo of the last reply is recognised as echo', () => {
  const spoken = ['That is live now, no dropped-speech restarts since. Tell me if anything still gets cut off.'];
  expect(isEcho('Their healthy new job speech to start since tell me your and still get all', spoken)).toBe(true);
});

// 2026-10-13: on the phone's speaker the echo runs on with no pause, so one heard segment spans
// several clips; checked clip by clip it matched none and came back as a barge in his name.
it('an echo spanning several clips is recognised as echo', () => {
  const spoken = [
    'I checked the daemon log for the last hour, and the window reconnected twice after the update.',
    'Nothing was lost.',
    'Every clip played in under half a second, so the next step is the settings change you asked for.',
  ];
  const heard =
    'the window reconnected twice after the update nothing was lost every clip played in under half a second so the next';
  expect(isEcho(heard, spoken)).toBe(true);
});
