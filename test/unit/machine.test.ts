import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { nextBackoff, pageMachine, watchdogVerdict } from '../../web/machine';

function start() {
  const startMic = vi.fn();
  const sendTurn = vi.fn();
  const playClip = vi.fn();
  const prefetchClips = vi.fn();
  const speakFallback = vi.fn();
  const actor = createActor(
    pageMachine.provide({ actions: { startMic, sendTurn, playClip, prefetchClips, speakFallback } }),
  ).start();
  return { actor, startMic, sendTurn, playClip, prefetchClips, speakFallback };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('page machine', () => {
  it('mute: nothing restarts the mic while paused', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'MIC_ERROR' });
    actor.send({ type: 'WATCHDOG' });
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'QUEUE_EMPTY' });
    vi.advanceTimersByTime(60000);
    expect(actor.getSnapshot().matches({ mic: 'paused' })).toBe(true);
    expect(startMic).not.toHaveBeenCalled();
  });

  it('untrusted pause and resume are ignored', () => {
    const { actor } = start();
    actor.send({ type: 'PAUSE', trusted: false });
    expect(actor.getSnapshot().matches({ mic: 'live' })).toBe(true);
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'RESUME', trusted: false });
    expect(actor.getSnapshot().matches({ mic: 'paused' })).toBe(true);
  });

  it('a listen request starts the mic once and the turn goes green', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_STARTED' });
    expect(startMic).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().matches({ mic: { live: 'listening' }, turn: 'speakNow' })).toBe(true);
  });

  it('a trusted resume with a pending listen starts the mic', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'RESUME', trusted: true });
    expect(startMic).toHaveBeenCalledTimes(1);
  });

  it('autosend arms on speechend only: 0.7 s, or 1 s when unfinished', () => {
    const { actor, sendTurn } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_STARTED' });
    actor.send({ type: 'RESULT', text: 'hello there' });
    vi.advanceTimersByTime(5000);
    expect(sendTurn).not.toHaveBeenCalled();
    actor.send({ type: 'SPEECH_END', text: 'hello there' });
    vi.advanceTimersByTime(699);
    expect(sendTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendTurn).toHaveBeenCalledWith(expect.anything(), { text: 'hello there' });

    const b = start();
    b.actor.send({ type: 'SPEECH_END', text: 'I want to go to the' });
    vi.advanceTimersByTime(700);
    expect(b.sendTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(b.sendTurn).toHaveBeenCalledTimes(1);
  });

  it('pause cancels an armed autosend', () => {
    const { actor, sendTurn } = start();
    actor.send({ type: 'SPEECH_END', text: 'done' });
    actor.send({ type: 'PAUSE', trusted: true });
    vi.advanceTimersByTime(5000);
    expect(sendTurn).not.toHaveBeenCalled();
    expect(actor.getSnapshot().matches({ autosend: 'off' })).toBe(true);
  });

  it('speech: 3 clips ahead, fallback on failure, results discarded, mic resumes when empty', () => {
    const { actor, startMic, playClip, prefetchClips, speakFallback } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_STARTED' });
    actor.send({ type: 'ENQUEUE', clips: ['a', 'b', 'c', 'd', 'e'] });
    expect(actor.getSnapshot().matches({ mic: { live: 'idle' }, turn: 'agentSpeaking' })).toBe(true);
    expect(playClip).toHaveBeenLastCalledWith(expect.anything(), { clip: 'a' });
    expect(prefetchClips).toHaveBeenLastCalledWith(expect.anything(), { clips: ['b', 'c', 'd'] });
    actor.send({ type: 'RESULT', text: 'echo' });
    expect(actor.getSnapshot().matches({ turn: 'agentSpeaking' })).toBe(true);
    actor.send({ type: 'CLIP_FAILED' });
    expect(speakFallback).toHaveBeenCalledWith(expect.anything(), { clip: 'a' });
    for (let i = 0; i < 4; i++) actor.send({ type: 'CLIP_ENDED' });
    expect(startMic).toHaveBeenCalledTimes(1);
    actor.send({ type: 'CLIP_ENDED' });
    expect(actor.getSnapshot().matches({ speech: 'idle', mic: { live: 'starting' } })).toBe(true);
    expect(startMic).toHaveBeenCalledTimes(2);
  });

  it('the watchdog checks every 2 s and restarts after 15 s of nothing', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_STARTED' });
    vi.advanceTimersByTime(14000);
    expect(startMic).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(1); // the 0 s backoff timer
    expect(startMic).toHaveBeenCalledTimes(2);
  });

  it('errors restart at once, then back off to at most 2 s', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_ERROR' });
    vi.advanceTimersByTime(0);
    expect(startMic).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) {
      actor.send({ type: 'MIC_ERROR' });
      vi.advanceTimersByTime(2000);
    }
    expect(actor.getSnapshot().context.backoff).toBe(2000);
    expect(startMic).toHaveBeenCalledTimes(12);
  });

  it('watchdogVerdict and nextBackoff edges', () => {
    const base = { now: 20000, running: true, endedAt: 0, speechAt: 0, resultAt: 0, heardAt: 19000 };
    expect(watchdogVerdict(base)).toBeNull();
    expect(watchdogVerdict({ ...base, running: false, endedAt: 13999 })).toMatch(/not running/);
    expect(watchdogVerdict({ ...base, speechAt: 11000, resultAt: 10000 })).toMatch(/8s/);
    expect(watchdogVerdict({ ...base, heardAt: 4000 })).toMatch(/15s/);
    expect([null, 0, 250, 1000, 2000].map((p) => nextBackoff(p))).toEqual([0, 250, 500, 2000, 2000]);
  });
});
