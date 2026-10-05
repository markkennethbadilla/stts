// The page machine (brief section 6): mic, turn, autosend, speech and watchdog rules.
// Side effects are named actions; the page supplies them with pageMachine.provide().
import { and, assign, not, or, raise, setup, stateIn } from 'xstate';
import { readsUnfinished } from '../src/protocol';

export const CLIPS_AHEAD = 3;
export const WATCHDOG_MS = 2000;
export const MAX_BACKOFF_MS = 2000;
export const LANG_ERR = 'language-not-supported';

/** Pure watchdog check: a reason to restart the mic, or null (6, 8, 15 s rules). */
export function watchdogVerdict(s: {
  now: number;
  running: boolean;
  endedAt: number;
  speechAt: number;
  resultAt: number;
  heardAt: number;
  // Speech playing: silence and wordless sound are expected, so only a dead mic restarts.
  playing?: boolean;
}): string | null {
  if (!s.running) return s.now - s.endedAt > 6000 ? 'not running during a listen' : null;
  if (s.playing) return null;
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

const norm = (t: string): string[] => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * A final heard while the agent speaks: 'barge' cuts the speech off, 'short' (under 3 words)
 * and 'echo' (80% of its words are in the sentence now playing) are discarded.
 * ponytail: word-overlap echo check; misses an echo the recogniser garbles past 20% and drops a
 * real barge that repeats the sentence. Upgrade: compare against the played audio, not its text.
 */
export function bargeVerdict(final: string, clip: string): 'barge' | 'short' | 'echo' {
  const words = norm(final);
  if (words.length < 3) return 'short';
  const said = new Set(norm(clip));
  return words.filter((w) => said.has(w)).length / words.length >= 0.8 ? 'echo' : 'barge';
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
  | { type: 'MIC_ERROR'; error?: string }
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
  // listen: the tts opens a listen after it, so the mic running during the speech stays on.
  | { type: 'ENQUEUE'; clips: string[]; listen?: boolean }
  | { type: 'CLIP_ENDED' }
  | { type: 'CLIP_FAILED' }
  | { type: 'STOP' }
  | { type: 'QUEUE_EMPTY' }
  // A message typed into the box and sent; part is the agent's current read-aloud part.
  | { type: 'TYPED'; text: string; part: number }
  // Final heard words while the agent is speaking: they cut the speech off.
  | { type: 'BARGE'; text: string; part: number }
  | { type: 'SET_TYPING'; on: boolean };

export type Interrupted = { part: number; sentence: number };
export type Delivery = { text: string; source: 'typed' | 'heard'; interrupted: Interrupted | null };

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
  // language-not-supported errors seen; the second one gives up instead of looping.
  langFails: number;
  // Text in the keyboard box: auto-send of heard speech waits while he types.
  typing: boolean;
  // 1-based index of the clip (sentence) now playing.
  sentence: number;
  // Where the last barge cut the agent's speech off.
  interrupted: Interrupted | null;
}

const cut = ({ context, event }: { context: PageContext; event: PageEvent }): Interrupted => ({
  part: 'part' in event ? event.part : 1,
  sentence: context.sentence,
});

const live = not(stateIn({ mic: 'paused' }));
const quiet = stateIn({ speech: 'idle' });
const playing = stateIn({ speech: 'playing' });
// The mic runs during a listen and while the agent speaks (so speaking over it barges in).
const wantMic = or([({ context }: { context: PageContext }) => context.wantListen, playing]);
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
    // Sends a typed message or a barge to the daemon as a turn.
    deliver: (_: unknown, _p: Delivery) => {},
    // Silences the playing clip at once (the Stop button's path).
    stopAudio: () => {},
    // The daemon logs these as "page <line>".
    log: (_: unknown, _p: { line: string }) => {},
  },
  guards: {
    trusted: ({ event }) => 'trusted' in event && event.trusted,
    canStart: and([live, wantMic]),
    wantMic,
    watchdogTrips: ({ context }) => watchdogVerdict({ ...context, now: now() }) !== null,
    // During speech only a dead mic restarts; no words is expected.
    deadMic: ({ context }) => watchdogVerdict({ ...context, now: now(), playing: true }) !== null,
    // A second language-not-supported error: cloud recognition was tried too, so stop.
    langGiveUp: ({ context, event }) =>
      event.type === 'MIC_ERROR' && event.error === LANG_ERR && context.langFails >= 1,
    autosendOn: ({ context }) => context.autosend && !context.typing,
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
    langFails: 0,
    typing: false,
    sentence: 1,
    interrupted: null,
  },
  on: {
    SET_TYPING: { actions: assign({ typing: ({ event }) => event.on }) },
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
                MIC_ERROR: [{ guard: 'langGiveUp', target: 'failed' }, { target: 'restarting' }],
              },
            },
            listening: {
              // The speech ended with no listen wanted: the mic goes off.
              always: { guard: not('wantMic'), target: 'idle', actions: 'stopMic' },
              after: {
                [WATCHDOG_MS]: [
                  { guard: and([playing, 'deadMic']), target: 'restarting' },
                  { guard: and([quiet, 'watchdogTrips']), target: 'restarting' },
                  { target: 'listening', reenter: true },
                ],
              },
              on: {
                MIC_ERROR: [{ guard: 'langGiveUp', target: 'failed' }, { target: 'restarting' }],
                WATCHDOG: 'restarting',
                MIC_ENDED: { actions: assign({ running: false, endedAt: now }) },
                AUDIO: { actions: assign({ heardAt: now }) },
                SPEECH_START: { actions: assign({ speechAt: now, heardAt: now }) },
                RESULT: { actions: assign({ resultAt: now, heardAt: now, backoff: null }) },
                LISTEN_DONE: { target: 'idle', actions: ['stopMic', assign({ wantListen: false })] },
                TYPED: { target: 'idle', actions: ['stopMic', assign({ wantListen: false })] },
              },
            },
            restarting: {
              entry: [
                'stopMic',
                assign({
                  backoff: ({ context }) => nextBackoff(context.backoff),
                  restarts: ({ context }) => context.restarts + 1,
                  langFails: ({ context, event }) =>
                    context.langFails + (event.type === 'MIC_ERROR' && event.error === LANG_ERR ? 1 : 0),
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
            // No recogniser for the language, locally or in the cloud: the mic stays off until a mute and unmute.
            failed: {
              entry: ['stopMic', { type: 'log', params: { line: `mic failed ${LANG_ERR}` } }],
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
        // A tts with listen whose mic already runs: speak now, no restart.
        QUEUE_EMPTY: [
          { guard: ({ context }) => context.wantListen && context.running, target: '.speakNow' },
          { target: '.notListening' },
        ],
        STOP: '.notListening',
        MIC_STARTED: { guard: 'quiet', target: '.speakNow' },
        INTERIM: { guard: 'quiet', target: '.heard' },
        SPEECH_END: { guard: 'quiet', target: '.heard' },
        RESULT: { guard: 'quiet', target: '.heard' },
        NOTIFY: '.background',
        TYPED: '.heard',
        BARGE: { guard: not('quiet'), target: '.heard' },
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
            TYPED: 'off',
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
            ENQUEUE: {
              target: 'playing',
              actions: assign({
                queue: ({ event }) => [...event.clips],
                sentence: 1,
                wantListen: ({ context, event }) => context.wantListen || event.listen === true,
              }),
            },
            TYPED: {
              actions: [
                assign({ interrupted: null }),
                { type: 'deliver', params: ({ event }) => ({ text: event.text, source: 'typed', interrupted: null }) },
              ],
            },
          },
        },
        playing: {
          // The watchdog clocks restart when the speech ends, so a long speech is not "no audio".
          exit: assign({ heardAt: now, speechAt: 0 }),
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
            // A barge: the message is delivered first, then the speech stops, so the daemon sees
            // the turn before the stopped speech's own complete.
            TYPED: {
              target: 'idle',
              actions: [
                assign({ interrupted: cut, wantListen: false }),
                {
                  type: 'deliver',
                  params: ({ context, event }) => ({
                    text: event.text,
                    source: 'typed',
                    interrupted: cut({ context, event }),
                  }),
                },
                'stopAudio',
                assign({ queue: [] }),
              ],
            },
            BARGE: {
              target: 'idle',
              actions: [
                assign({ interrupted: cut, wantListen: false }),
                {
                  type: 'deliver',
                  params: ({ context, event }) => ({
                    text: event.text,
                    source: 'heard',
                    interrupted: cut({ context, event }),
                  }),
                },
                'stopAudio',
                assign({ queue: [] }),
              ],
            },
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
                actions: assign({
                  queue: ({ context }) => context.queue.slice(1),
                  sentence: ({ context }) => context.sentence + 1,
                }),
              },
            ],
          },
        },
      },
    },
  },
});
