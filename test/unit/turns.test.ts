import { describe, expect, it } from 'vitest';
import { createActor, SimulatedClock } from 'xstate';
import { unansweredError } from '../../src/protocol.js';
import { ackGate, turnsMachine } from '../../src/turns.js';

const T = 1_700_000_000_000;
const start = () => {
  const clock = new SimulatedClock();
  const a = createActor(turnsMachine, { input: { joinSec: 3 }, clock }).start();
  const hear = (text: string, endAt: number) => a.send({ type: 'heard', text, startAt: endAt - 500, endAt });
  return { a, clock, hear, ctx: () => a.getSnapshot().context };
};

describe('turns', () => {
  it('ids always rise and the reply carries the turn prefix', () => {
    const { hear, ctx } = start();
    hear('hello there', T);
    expect(ctx().id).toBe(1);
    expect(ctx().reply).toMatch(/^\[turn 1, heard \d\d:\d\d:\d\d to \d\d:\d\d:\d\d\] hello there$/);
    hear('second one', T + 5000);
    expect(ctx().id).toBe(2);
  });
  it('drops a duplicate within 1 s but keeps it after', () => {
    const { hear, ctx } = start();
    hear('yes', T);
    hear('yes', T + 900);
    expect(ctx().id).toBe(1);
    hear('yes', T + 1000);
    expect(ctx().id).toBe(2);
  });
  it('drops stale speech', () => {
    const { hear, ctx } = start();
    hear('new', T + 5000);
    hear('old', T);
    expect(ctx().id).toBe(1);
    expect(ctx().last?.text).toBe('new');
  });
  it('joins unfinished speech, else finishes after the join window', () => {
    const { hear, ctx, clock } = start();
    hear('I was thinking about', T);
    expect(ctx().id).toBe(0);
    hear('the plan', T + 2000);
    expect(ctx().id).toBe(1);
    expect(ctx().last?.text).toBe('I was thinking about the plan');
    hear('and', T + 9000);
    clock.increment(2999);
    expect(ctx().id).toBe(1);
    clock.increment(1);
    expect(ctx().id).toBe(2);
    expect(ctx().last?.text).toBe('and');
  });
  it('the join never ends while he is talking again', () => {
    const clock = new SimulatedClock();
    let talking = false;
    const a = createActor(turnsMachine, { input: { joinSec: 3, talking: () => talking }, clock }).start();
    a.send({ type: 'heard', text: 'the thing about that is not just', startAt: T, endAt: T + 500 });
    talking = true;
    clock.increment(5000);
    expect(a.getSnapshot().context.id).toBe(0);
    a.send({ type: 'heard', text: 'replace tools.', startAt: T + 5000, endAt: T + 6000 });
    expect(a.getSnapshot().context.last?.text).toBe('the thing about that is not just replace tools.');
  });
  it('words held just before a listen opened wait 1.5 s for the rest, finished or not', () => {
    const { a, ctx, clock } = start();
    a.send({ type: 'heard', text: 'it is hard to replace tools.', startAt: T, endAt: T + 500, open: true });
    expect(ctx().id).toBe(0);
    clock.increment(1000);
    a.send({ type: 'heard', text: 'People use them daily.', startAt: T + 900, endAt: T + 1500 });
    expect(ctx().id).toBe(1);
    expect(ctx().last?.text).toBe('it is hard to replace tools. People use them daily.');
    a.send({ type: 'heard', text: 'All done.', startAt: T + 9000, endAt: T + 9500, open: true });
    clock.increment(1499);
    expect(ctx().id).toBe(1);
    clock.increment(1);
    expect(ctx().id).toBe(2);
  });
  it('joins at most 3 times', () => {
    const { hear, ctx } = start();
    hear('so', T);
    hear('and', T + 1000);
    hear('but', T + 2000);
    expect(ctx().id).toBe(0);
    hear('the', T + 3000);
    expect(ctx().id).toBe(1);
    expect(ctx().last?.text).toBe('so and but the');
  });
  it('reads STTS_JOIN_SEC when no input is given', () => {
    process.env['STTS_JOIN_SEC'] = '5';
    const a = createActor(turnsMachine, { input: {}, clock: new SimulatedClock() }).start();
    delete process.env['STTS_JOIN_SEC'];
    expect(a.getSnapshot().context.joinMs).toBe(5000);
  });
  it('ack gate returns the 409 text until answered or acked', () => {
    const { a, hear, ctx } = start();
    expect(ackGate(ctx())).toBeNull();
    hear('hi', T);
    expect(ackGate(ctx())).toBe(unansweredError(1));
    expect(ackGate(ctx(), 0)).toBe(unansweredError(1));
    expect(ackGate(ctx(), 1)).toBeNull();
    a.send({ type: 'answered' });
    expect(ackGate(ctx())).toBeNull();
  });
  it('no-speech, continues and background-result are not turns', () => {
    const { a, hear, ctx } = start();
    hear('hi', T);
    for (const type of ['nospeech', 'continues', 'background'] as const) a.send({ type });
    expect(ctx().id).toBe(1);
    expect(ctx().answered).toBe(false);
  });
});
