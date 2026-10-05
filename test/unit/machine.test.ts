import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { bargeVerdict, nextBackoff, pageMachine, watchdogVerdict } from '../../web/machine';

function start() {
  const startMic = vi.fn();
  const sendTurn = vi.fn();
  const playClip = vi.fn();
  const prefetchClips = vi.fn();
  const speakFallback = vi.fn();
  const deliver = vi.fn();
  const stopAudio = vi.fn();
  const actor = createActor(
    pageMachine.provide({
      actions: { startMic, sendTurn, playClip, prefetchClips, speakFallback, deliver, stopAudio },
    }),
  ).start();
  return { actor, startMic, sendTurn, playClip, prefetchClips, speakFallback, deliver, stopAudio };
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

  it('typed while paused still produces a turn and never starts the mic', () => {
    const { actor, startMic, deliver } = start();
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'TYPED', text: 'hi', part: 1 });
    vi.advanceTimersByTime(60000);
    expect(deliver).toHaveBeenCalledWith(expect.anything(), { text: 'hi', source: 'typed', interrupted: null });
    expect(actor.getSnapshot().matches({ mic: 'paused' })).toBe(true);
    expect(startMic).not.toHaveBeenCalled();
  });

  it('typing suspends auto-send of heard speech', () => {
    const { actor, sendTurn } = start();
    actor.send({ type: 'SET_TYPING', on: true });
    actor.send({ type: 'SPEECH_END', text: 'hello' });
    vi.advanceTimersByTime(5000);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('BARGE stops speech, records where, and keeps the mic rule', () => {
    const { actor, startMic, deliver, stopAudio } = start();
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'ENQUEUE', clips: ['a', 'b', 'c'] });
    actor.send({ type: 'CLIP_ENDED' });
    actor.send({ type: 'BARGE', text: 'wait', part: 2 });
    const s = actor.getSnapshot();
    expect(s.matches({ speech: 'idle' })).toBe(true);
    expect(s.context.queue).toEqual([]);
    expect(s.context.interrupted).toEqual({ part: 2, sentence: 2 });
    expect(stopAudio).toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(expect.anything(), {
      text: 'wait',
      source: 'heard',
      interrupted: { part: 2, sentence: 2 },
    });
    expect(s.matches({ mic: 'paused' })).toBe(true);
    expect(startMic).not.toHaveBeenCalled();
  });

  it('stop empties the speech queue so the next tts plays', () => {
    const { actor, playClip } = start();
    actor.send({ type: 'ENQUEUE', clips: ['a', 'b'] });
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().matches({ speech: 'idle' })).toBe(true);
    actor.send({ type: 'ENQUEUE', clips: ['c'] });
    expect(playClip).toHaveBeenLastCalledWith(expect.anything(), { clip: 'c' });
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

  it('hold_ms overrides the autosend delay; null restores the defaults', () => {
    const { actor, sendTurn } = start();
    actor.send({ type: 'SET_HOLD', ms: 2000 });
    actor.send({ type: 'SPEECH_END', text: 'I want to go to the' });
    vi.advanceTimersByTime(1999);
    expect(sendTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendTurn).toHaveBeenCalledTimes(1);

    const b = start();
    b.actor.send({ type: 'SET_HOLD', ms: 2000 });
    b.actor.send({ type: 'SET_HOLD', ms: null });
    b.actor.send({ type: 'SPEECH_END', text: 'done' });
    vi.advanceTimersByTime(700);
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

  it('speech: 3 clips ahead, fallback on failure, results discarded, mic stays on through it', () => {
    const { actor, startMic, playClip, prefetchClips, speakFallback } = start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_STARTED' });
    actor.send({ type: 'ENQUEUE', clips: ['a', 'b', 'c', 'd', 'e'] });
    expect(actor.getSnapshot().matches({ mic: { live: 'listening' }, turn: 'agentSpeaking' })).toBe(true);
    expect(playClip).toHaveBeenLastCalledWith(expect.anything(), { clip: 'a' });
    expect(prefetchClips).toHaveBeenLastCalledWith(expect.anything(), { clips: ['b', 'c', 'd'] });
    actor.send({ type: 'RESULT', text: 'echo' });
    expect(actor.getSnapshot().matches({ turn: 'agentSpeaking' })).toBe(true);
    actor.send({ type: 'CLIP_FAILED' });
    expect(speakFallback).toHaveBeenCalledWith(expect.anything(), { clip: 'a' });
    for (let i = 0; i < 4; i++) actor.send({ type: 'CLIP_ENDED' });
    expect(startMic).toHaveBeenCalledTimes(1);
    // 20 s of speech with no words: the watchdog leaves the mic alone.
    vi.advanceTimersByTime(20000);
    actor.send({ type: 'CLIP_ENDED' });
    expect(actor.getSnapshot().matches({ speech: 'idle', mic: { live: 'listening' }, turn: 'speakNow' })).toBe(true);
    expect(startMic).toHaveBeenCalledTimes(1);
  });

  it('spoken barge: a final during speech is BARGE; interims, short finals and no-listen speech end', () => {
    const { actor, startMic, deliver, stopAudio, sendTurn } = start();
    actor.send({ type: 'ENQUEUE', clips: ['Hello there.', 'More.'] });
    // A plain tts still runs the mic so speaking over it barges in.
    expect(actor.getSnapshot().matches({ mic: { live: 'starting' } })).toBe(true);
    actor.send({ type: 'MIC_STARTED' });
    expect(actor.getSnapshot().matches({ turn: 'agentSpeaking' })).toBe(true);
    actor.send({ type: 'INTERIM', text: 'wait' });
    actor.send({ type: 'SPEECH_END', text: 'wait' });
    vi.advanceTimersByTime(5000);
    expect(sendTurn).not.toHaveBeenCalled();
    expect(actor.getSnapshot().matches({ speech: 'playing', turn: 'agentSpeaking' })).toBe(true);
    actor.send({ type: 'BARGE', text: 'stop and check the logs', part: 1 });
    expect(stopAudio).toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(expect.anything(), {
      text: 'stop and check the logs',
      source: 'heard',
      interrupted: { part: 1, sentence: 1 },
    });
    // No listen wanted after the barge: the mic goes off.
    expect(actor.getSnapshot().matches({ speech: 'idle', mic: { live: 'idle' } })).toBe(true);
    expect(startMic).toHaveBeenCalledTimes(1);
    actor.send({ type: 'ENQUEUE', clips: ['x'] });
    actor.send({ type: 'MIC_STARTED' });
    actor.send({ type: 'CLIP_ENDED' });
    expect(actor.getSnapshot().matches({ mic: { live: 'idle' }, turn: 'notListening' })).toBe(true);
  });

  it('paused stays paused through speech: no mic during playback', () => {
    const { actor, startMic } = start();
    actor.send({ type: 'PAUSE', trusted: true });
    actor.send({ type: 'ENQUEUE', clips: ['a', 'b'], listen: true });
    vi.advanceTimersByTime(20000);
    actor.send({ type: 'CLIP_ENDED' });
    actor.send({ type: 'CLIP_ENDED' });
    expect(actor.getSnapshot().matches({ mic: 'paused' })).toBe(true);
    expect(startMic).not.toHaveBeenCalled();
  });

  it('bargeVerdict: short, echo, barge', () => {
    expect(bargeVerdict('stop it', 'The build is green.')).toBe('short');
    expect(bargeVerdict('the build is green', 'The build is green.')).toBe('echo');
    expect(bargeVerdict('build is green now', 'The build is green.')).toBe('barge');
    expect(bargeVerdict('wait use the other repo', 'The build is green.')).toBe('barge');
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

  it('language-not-supported restarts once, then fails with one log line and no loop', () => {
    const log = vi.fn();
    const startMic = vi.fn();
    const actor = createActor(pageMachine.provide({ actions: { startMic, log } })).start();
    actor.send({ type: 'REQUEST', kind: 'listen' });
    actor.send({ type: 'MIC_ERROR', error: 'language-not-supported' });
    vi.advanceTimersByTime(0);
    expect(startMic).toHaveBeenCalledTimes(2);
    actor.send({ type: 'MIC_ERROR', error: 'language-not-supported' });
    vi.advanceTimersByTime(60000);
    expect(startMic).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().matches({ mic: { live: 'failed' } })).toBe(true);
    const lines = log.mock.calls.map((c) => (c[1] as { line: string }).line);
    expect(lines.filter((l) => l.startsWith('mic restart'))).toHaveLength(1);
    expect(lines.filter((l) => l === 'mic failed language-not-supported')).toHaveLength(1);
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
