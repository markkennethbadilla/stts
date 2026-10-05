// Turn ids (always rising), dedupe within 1 s, stale drop, join of unfinished speech, ack gate.
import { assign, setup } from 'xstate';
import { readsUnfinished, turnReply, unansweredError } from './protocol.js';

export const DEDUPE_MS = 1000;
export const MAX_JOINS = 3;
export const joinSec = (): number => Number(process.env['STTS_JOIN_SEC'] ?? 3);

export type Heard = { text: string; startAt: number; endAt: number; typed?: boolean | undefined };
type Ctx = {
  joinMs: number;
  id: number;
  answered: boolean;
  last: Heard | null;
  pending: Heard | null;
  joins: number;
  reply: string | null;
};
export type TurnsEvent =
  | ({ type: 'heard' } & Heard)
  | { type: 'answered' }
  | { type: 'nospeech' }
  | { type: 'continues' }
  | { type: 'background' };

// Stale: ended before the last turn ended. Duplicate: same text ending within 1 s of the last.
const dropped = (c: Ctx, h: Heard): boolean => {
  const ref = c.pending ?? c.last;
  if (!ref) return false;
  if (h.endAt < ref.endAt) return true;
  return h.text.trim() === ref.text.trim() && h.endAt - ref.endAt < DEDUPE_MS;
};

export const turnsMachine = setup({
  types: { context: {} as Ctx, events: {} as TurnsEvent, input: {} as { joinSec?: number } },
  delays: { join: ({ context }) => context.joinMs },
  guards: {
    fresh: ({ context, event }) => event.type === 'heard' && !dropped(context, event),
    wantsJoin: ({ context }) =>
      context.pending !== null && context.joins < MAX_JOINS && readsUnfinished(context.pending.text),
  },
  actions: {
    take: assign(({ context: c, event }) => {
      if (event.type !== 'heard') return {};
      const p = c.pending;
      const pending = p
        ? { text: `${p.text} ${event.text}`, startAt: p.startAt, endAt: event.endAt, typed: event.typed }
        : { text: event.text, startAt: event.startAt, endAt: event.endAt, typed: event.typed };
      return { pending, joins: p ? c.joins + 1 : 0 };
    }),
    finish: assign(({ context: c }) => {
      const h = c.pending;
      if (!h) return {};
      const id = c.id + 1;
      return {
        id,
        answered: false,
        last: h,
        pending: null,
        joins: 0,
        reply: turnReply(id, h.text, h.startAt, h.endAt, h.typed),
      };
    }),
  },
}).createMachine({
  id: 'turns',
  context: ({ input }) => ({
    joinMs: (input.joinSec ?? joinSec()) * 1000,
    id: 0,
    answered: true,
    last: null,
    pending: null,
    joins: 0,
    reply: null,
  }),
  initial: 'idle',
  // nospeech, continues and background are not turns: no handler, nothing changes.
  on: { answered: { actions: assign({ answered: true }) } },
  states: {
    idle: { on: { heard: { guard: 'fresh', target: 'check', actions: 'take' } } },
    check: {
      always: [
        { guard: 'wantsJoin', target: 'joining' },
        { target: 'idle', actions: 'finish' },
      ],
    },
    joining: {
      after: { join: { target: 'idle', actions: 'finish' } },
      on: { heard: { guard: 'fresh', target: 'check', actions: 'take' } },
    },
  },
});

// The ack gate: the 409 text while the last turn is unanswered, unless ack names it.
export const ackGate = (c: { id: number; answered: boolean }, ack?: number): string | null =>
  c.answered || ack === c.id ? null : unansweredError(c.id);
