// The page machine (brief section 6): mic, turn, autosend, speech and watchdog rules.
// Side effects are named actions; the page supplies them with pageMachine.provide().
import { distance } from 'fastest-levenshtein';
import { and, assign, not, or, raise, setup, stateIn } from 'xstate';
import { readsUnfinished } from '../src/protocol';

export const CLIPS_AHEAD = 3;
/**
 * Extra hold when the words are still interim. Chrome's cloud recogniser can keep every result
 * interim through a 12 s pause, so only finals arming made every cloud turn wait for the 60 s
 * session end (real Chrome test, 2026-10-06). Interim words unchanged for hold + this are a turn.
 */
export const INTERIM_EXTRA_MS = 800;
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

/** Silence before autosend: the set hold, else 1 s when the transcript reads unfinished, 700 ms otherwise. */
export function holdMs(c: Pick<PageContext, 'holdMs' | 'transcript'>): number {
  return c.holdMs ?? (readsUnfinished(c.transcript) ? 1000 : 700);
}

const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/'/g, '')
    .match(/[a-z0-9]+/g) ?? [];

const sharesEnd = (a: string[], b: string[]): boolean =>
  a.length >= 2 &&
  b.length >= 2 &&
  (a.slice(0, 2).join(' ') === b.slice(0, 2).join(' ') || a.slice(-2).join(' ') === b.slice(-2).join(' '));

/**
 * Is a heard final the agent's own voice? Checked against every sentence spoken in the last 10 s,
 * normalised (lowercase, no punctuation): echo when the Levenshtein similarity is at least 0.5, or
 * when it is under 60% of the sentence's length and shares its first or last two words.
 * ponytail: text distance against what was said; an echo garbled past half still slips through
 * and a barge that repeats the sentence is dropped. Upgrade: compare against the played audio.
 */
export function isEcho(final: string, spoken: readonly string[]): boolean {
  const hw = words(final);
  const h = hw.join(' ');
  if (!h) return false;
  return spoken.some((clip) => {
    const sw = words(clip);
    const s = sw.join(' ');
    if (!s) return false;
    if (1 - distance(h, s) / Math.max(h.length, s.length) >= 0.5) return true;
    return h.length < 0.6 * s.length && sharesEnd(hw, sw);
  });
}

/** A final this soon after its clip started is the clip's own echo, never a barge. */
export const BARGE_MIN_MS = 600;

/**
 * A final heard while the agent speaks: 'barge' cuts the speech off; 'short' (under 3 words) and
 * 'echo' (isEcho, or under BARGE_MIN_MS into the clip) are discarded.
 */
export function bargeVerdict(final: string, spoken: readonly string[], msIntoClip: number): 'barge' | 'short' | 'echo' {
  if (words(final).length < 3) return 'short';
  return isEcho(final, spoken) || msIntoClip < BARGE_MIN_MS ? 'echo' : 'barge';
}

/** Why the mic is restarting, for the "mic restart #N: reason" log line. */
export function restartReason(event: { type: string }, c: PageContext): string {
  if (event.type === 'MIC_ERROR') return 'mic error';
  if (event.type === 'WATCHDOG') return 'watchdog';
  if (event.type === 'MIC_ENDED') return 'recogniser ended';
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
  | { type: 'CLIP_FAILED'; reason: string }
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
  // The mic start in progress is an automatic restart (no chime).
  auto: boolean;
  // The armed transcript is still interim (no final yet): the hold is longer.
  interimHold: boolean;
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
    // Only an open listen sends: a speechend after the turn went out sent it twice (log 2026-10-06).
    listenOpen: ({ context }) => context.wantListen,
    quiet,
  },
  delays: {
    backoff: ({ context }) => context.backoff ?? 0,
    autosend: ({ context }) => holdMs(context) + (context.interimHold ? INTERIM_EXTRA_MS : 0),
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
    auto: false,
    interimHold: false,
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
              always: { guard: 'canStart', target: 'starting', actions: assign({ auto: false }) },
              on: {},
            },
            starting: {
              // The only place the mic starts; every path here passes canStart (!paused).
              // speechAt resets: an old speechstart made the 8 s rule trip on every restart, a loop every
              // 3.5 s (log 2026-10-06 21:44 to 21:47 UTC).
              entry: ['startMic', assign({ running: false, endedAt: now, heardAt: now, speechAt: 0 })],
              on: {
                MIC_STARTED: {
                  target: 'listening',
                  actions: [assign({ running: true }), { type: 'log', params: { line: 'mic start' } }],
                },
                MIC_ERROR: [{ guard: 'langGiveUp', target: 'failed' }, { target: 'restarting' }],
              },
              // A start that never reports back (no onstart, no error) restarts instead of hanging with the
              // mic off: the light stayed grey after every reply (log 2026-10-06 21:54 to 21:57 UTC).
              after: {
                5000: { target: 'restarting', actions: { type: 'log', params: { line: 'mic start timed out' } } },
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
                // Chrome ends a continuous session on its own (silence, network). Restart at once:
                // waiting for the 6 s watchdog left the light green over a dead mic.
                MIC_ENDED: { target: 'restarting', actions: assign({ running: false, endedAt: now }) },
                AUDIO: { actions: assign({ heardAt: now }) },
                SPEECH_START: { actions: assign({ speechAt: now, heardAt: now }) },
                RESULT: { actions: assign({ resultAt: now, heardAt: now, backoff: null }) },
                INTERIM: { actions: assign({ resultAt: now, heardAt: now, backoff: null }) },
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
              // An automatic restart opens the mic without the chime (Mark 2026-10-06).
              after: {
                backoff: [
                  { guard: 'canStart', target: 'starting', actions: assign({ auto: true }) },
                  { target: 'idle' },
                ],
              },
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
        // Green only while a listen is open: a mic restarted after the turn went out showed green over
        // a closed listen, so his words went nowhere (log 2026-10-06 21:22-21:29).
        MIC_STARTED: { guard: and(['quiet', 'listenOpen']), target: '.speakNow' },
        INTERIM: { guard: and(['quiet', 'listenOpen']), target: '.heard' },
        SPEECH_END: { guard: and(['quiet', 'listenOpen']), target: '.heard' },
        RESULT: { guard: and(['quiet', 'listenOpen']), target: '.heard' },
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
              guard: and(['autosendOn', 'quiet', live, 'listenOpen', ({ event }) => event.text !== '']),
              target: 'armed',
              actions: assign({ transcript: ({ event }) => event.text, interimHold: false }),
            },
            INTERIM: {
              guard: and(['autosendOn', 'quiet', live, 'listenOpen', ({ event }) => event.text !== '']),
              target: 'armed',
              actions: assign({ transcript: ({ event }) => event.text, interimHold: true }),
            },
            // A final result is the recogniser's own end of utterance. Chrome's speechend in
            // continuous mode fires only when the session ends (the 15 s watchdog restart), so
            // arming on it alone held every turn 15 s or more (Mark, 2026-10-06).
            RESULT: {
              guard: and(['autosendOn', 'quiet', live, 'listenOpen', ({ event }) => event.text !== '']),
              target: 'armed',
              actions: assign({ transcript: ({ event }) => event.text, interimHold: false }),
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
            // No SPEECH_START here: a new session starting after an error would drop a turn whose words
            // were already heard. New words restart the hold through INTERIM and RESULT instead.
            // New words restart the hold: a turn is words that stopped changing.
            INTERIM: {
              target: 'armed',
              reenter: true,
              actions: assign({ transcript: ({ event }) => event.text, interimHold: true }),
            },
            // The listen closed or the agent started speaking: a late speechend must not send again.
            LISTEN_DONE: 'off',
            ENQUEUE: 'off',
            // Another final: the hold restarts on the longer transcript.
            RESULT: {
              target: 'armed',
              reenter: true,
              actions: assign({ transcript: ({ event }) => event.text, interimHold: false }),
            },
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
              actions: [
                { type: 'log', params: ({ event }) => ({ line: `voice fallback ${event.reason}` }) },
                { type: 'speakFallback', params: ({ context }) => ({ clip: context.queue[0] ?? '' }) },
              ],
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
