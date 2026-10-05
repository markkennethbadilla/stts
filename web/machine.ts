// The page machine (brief section 6): mic, turn, autosend, speech and watchdog rules.
// Side effects are named actions; the page supplies them with pageMachine.provide().
import { and, assign, not, raise, setup, stateIn } from 'xstate';
import { readsUnfinished } from '../src/protocol';

export const CLIPS_AHEAD = 3;
export const WATCHDOG_MS = 2000;
export const MAX_BACKOFF_MS = 2000;

/** Pure watchdog check: a reason to restart the mic, or null (6, 8, 15 s rules). */
export function watchdogVerdict(s: {
  now: number;
  running: boolean;
  endedAt: number;
  speechAt: number;
  resultAt: number;
  heardAt: number;
}): string | null {
  if (!s.running) return s.now - s.endedAt > 6000 ? 'not running during a listen' : null;
  if (s.speechAt > s.resultAt && s.now - s.speechAt > 8000) return 'speech heard but no words for 8s';
  if (s.now - s.heardAt > 15000) return 'no audio or words for 15s during a listen';
  return null;
}

/** Restart delay after consecutive errors: 0 at once, then doubling to at most 2 s. */
export function nextBackoff(prev: number | null): number {
  if (prev === null) return 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(250, prev * 2));
}

/** Why the mic is restarting, for the "mic restart #N: reason" log line. */
export function holdMs(c: Pick<PageContext, 'holdMs' | 'transcript'>): number {
  return c.holdMs ?? (readsUnfinished(c.transcript) ? 1000 : 700);
}

export function restartReason(event: { type: string }, c: PageContext): string {
  if (event.type === 'MIC_ERROR') return 'mic error';
  if (event.type === 'WATCHDOG') return 'watchdog';
  return watchdogVerdict({ ...c, now: Date.now() }) ?? 'watchdog';
}

export type PageEvent =
  | { type: 'PAUSE'; trusted: boolean }
  | { type: 'RESUME'; trusted: boolean }
  | { type: 'REQUEST'; kind: 'listen' | 'speak' }
  | { type: 'MIC_STARTED' }
  | { type: 'MIC_ENDED' }
  | { type: 'MIC_ERROR' }
  | { type: 'WATCHDOG' }
  | { type: 'AUDIO' }
  | { type: 'SPEECH_START' }
  | { type: 'INTERIM'; text: string }
  | { type: 'SPEECH_END'; text: string }
  | { type: 'RESULT'; text: string }
  | { type: 'NOTIFY'; text: string }
  | { type: 'LISTEN_DONE' }
  | { type: 'SET_AUTOSEND'; on: boolean }
  | { type: 'SET_HOLD'; ms: number | null }
  | { type: 'ENQUEUE'; clips: string[] }
  | { type: 'CLIP_ENDED' }
  | { type: 'CLIP_FAILED' }
  | { type: 'STOP' }
  | { type: 'QUEUE_EMPTY' };

export interface PageContext {
  autosend: boolean;
  // The hold_ms setting; null keeps the defaults (0.7 s, or 1 s when the words read unfinished).
  holdMs: number | null;
  wantListen: boolean;
  transcript: string;
  backoff: number | null;
  queue: string[];
  running: boolean;
  endedAt: number;
  speechAt: number;
  resultAt: number;
  heardAt: number;
  restarts: number;
}

const live = not(stateIn({ mic: 'paused' }));
const quiet = stateIn({ speech: 'idle' });
const now = () => Date.now();

export const pageMachine = setup({
  types: { context: {} as PageContext, events: {} as PageEvent },
  actions: {
    startMic: () => {},
    stopMic: () => {},
    sendTurn: (_: unknown, _p: { text: string }) => {},
    prefetchClips: (_: unknown, _p: { clips: string[] }) => {},
    playClip: (_: unknown, _p: { clip: string }) => {},
    speakFallback: (_: unknown, _p: { clip: string }) => {},
    // The daemon logs these as "page <line>".
    log: (_: unknown, _p: { line: string }) => {},
  },
  guards: {
    trusted: ({ event }) => 'trusted' in event && event.trusted,
    canStart: and([live, quiet, ({ context }) => context.wantListen]),
    watchdogTrips: ({ context }) => watchdogVerdict({ ...context, now: now() }) !== null,
    autosendOn: ({ context }) => context.autosend,
    quiet,
  },
  delays: {
    backoff: ({ context }) => context.backoff ?? 0,
    autosend: ({ context }) => holdMs(context),
  },
}).createMachine({
  id: 'page',
  type: 'parallel',
  context: {
    autosend: true,
    holdMs: null,
    wantListen: false,
    transcript: '',
    backoff: null,
    queue: [],
    running: false,
    endedAt: 0,
    speechAt: 0,
    resultAt: 0,
    heardAt: 0,
    restarts: 0,
  },
  on: {
    SET_AUTOSEND: { actions: assign({ autosend: ({ event }) => event.on }) },
    SET_HOLD: { actions: assign({ holdMs: ({ event }) => event.ms }) },
    // A listen request is remembered even while paused; only a trusted resume acts on it.
    REQUEST: { guard: ({ event }) => event.kind === 'listen', actions: assign({ wantListen: true }) },
  },
  states: {
    mic: {
      initial: 'live',
      states: {
        paused: {
          entry: 'stopMic',
          on: { RESUME: { guard: 'trusted', target: 'live' } },
        },
        live: {
          initial: 'idle',
          on: { PAUSE: { guard: 'trusted', target: 'paused' } },
          states: {
            idle: {
              always: { guard: 'canStart', target: 'starting' },
              on: {},
            },
            starting: {
              // The only place the mic starts; every path here passes canStart (!paused).
              entry: ['startMic', assign({ running: false, endedAt: now, heardAt: now })],
              on: {
                MIC_STARTED: {
                  target: 'listening',
                  actions: [assign({ running: true }), { type: 'log', params: { line: 'mic start' } }],
                },
                MIC_ERROR: 'restarting',
              },
            },
            listening: {
              after: {
                [WATCHDOG_MS]: [
                  { guard: 'watchdogTrips', target: 'restarting' },
                  { target: 'listening', reenter: true },
                ],
              },
              on: {
                MIC_ERROR: 'restarting',
                WATCHDOG: 'restarting',
                MIC_ENDED: { actions: assign({ running: false, endedAt: now }) },
                AUDIO: { actions: assign({ heardAt: now }) },
                SPEECH_START: { actions: assign({ speechAt: now, heardAt: now }) },
                RESULT: { actions: assign({ resultAt: now, heardAt: now, backoff: null }) },
                LISTEN_DONE: { target: 'idle', actions: ['stopMic', assign({ wantListen: false })] },
                ENQUEUE: { target: 'idle', actions: 'stopMic' },
              },
            },
            restarting: {
              entry: [
                'stopMic',
                assign({
                  backoff: ({ context }) => nextBackoff(context.backoff),
                  restarts: ({ context }) => context.restarts + 1,
                }),
                {
                  type: 'log',
                  params: ({ context, event }) => ({
                    line: `mic restart #${context.restarts}: ${restartReason(event, context)}`,
                  }),
                },
              ],
              after: { backoff: [{ guard: 'canStart', target: 'starting' }, { target: 'idle' }] },
            },
          },
        },
      },
    },
    turn: {
      initial: 'notListening',
      states: {
        notListening: {},
        speakNow: {},
        heard: {},
        background: {},
        agentSpeaking: {},
      },
      on: {
        PAUSE: { guard: 'trusted', target: '.notListening' },
        LISTEN_DONE: '.notListening',
        QUEUE_EMPTY: '.notListening',
        STOP: '.notListening',
        MIC_STARTED: '.speakNow',
        INTERIM: { guard: 'quiet', target: '.heard' },
        SPEECH_END: { guard: 'quiet', target: '.heard' },
        RESULT: { guard: 'quiet', target: '.heard' },
        NOTIFY: '.background',
        ENQUEUE: '.agentSpeaking',
      },
    },
    autosend: {
      initial: 'off',
      states: {
        off: {
          on: {
            SPEECH_END: {
              guard: and(['autosendOn', 'quiet', live]),
              target: 'armed',
              actions: assign({ transcript: ({ event }) => event.text }),
            },
          },
        },
        armed: {
          after: {
            autosend: {
              target: 'off',
              actions: [
                { type: 'sendTurn', params: ({ context }) => ({ text: context.transcript }) },
                assign({ wantListen: false }),
              ],
            },
          },
          on: {
            PAUSE: { guard: 'trusted', target: 'off' },
            SPEECH_START: 'off',
            INTERIM: 'off',
            SET_AUTOSEND: { guard: ({ event }) => !event.on, target: 'off' },
          },
        },
      },
    },
    speech: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            ENQUEUE: { target: 'playing', actions: assign({ queue: ({ event }) => [...event.clips] }) },
          },
        },
        playing: {
          entry: [
            { type: 'playClip', params: ({ context }) => ({ clip: context.queue[0] ?? '' }) },
            {
              type: 'prefetchClips',
              params: ({ context }) => ({ clips: context.queue.slice(1, 1 + CLIPS_AHEAD) }),
            },
          ],
          on: {
            ENQUEUE: {
              actions: [
                assign({ queue: ({ context, event }) => [...context.queue, ...event.clips] }),
                {
                  type: 'prefetchClips',
                  params: ({ context }) => ({ clips: context.queue.slice(1, 1 + CLIPS_AHEAD) }),
                },
              ],
            },
            // Stop: the paused clip never ends, so the queue is dropped here or the next tts never plays.
            STOP: { target: 'idle', actions: assign({ queue: [] }) },
            CLIP_FAILED: {
              actions: { type: 'speakFallback', params: ({ context }) => ({ clip: context.queue[0] ?? '' }) },
            },
            CLIP_ENDED: [
              {
                guard: ({ context }) => context.queue.length <= 1,
                target: 'idle',
                actions: [assign({ queue: [] }), raise({ type: 'QUEUE_EMPTY' })],
              },
              {
                target: 'playing',
                reenter: true,
                actions: assign({ queue: ({ context }) => context.queue.slice(1) }),
              },
            ],
          },
        },
      },
    },
  },
});
