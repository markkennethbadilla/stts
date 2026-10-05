// The wire contract between the MCP server, the daemon and the page. Every
// sentinel, note, reply format and message shape is defined here and nowhere else.
import { z } from 'zod';

// Daemon routes on 127.0.0.1:${STTS_PORT ?? 15986}: GET / (the page), GET /api/ping (ok + X-Stts-Dir),
// POST /request, POST /api/shutdown, GET /barge ({text:'', open}), POST /notify,
// GET /earcon/:name.ogg, POST /voice/clip ({text, voice, rate} -> audio/wav from Piper; the page's
// speech source, kept so the page needs one origin), and the WebSocket /ws.
// /request answers plain text: 200 is the reply, any other status is the error text.
export const DEFAULT_PORT = 15986;
export const DEFAULT_IDLE_SEC = 200;
export const REQUEST_TIMEOUT_MS = 240_000;

// Sentinels: a reply that is exactly one of these is a signal, not speech.
export const CONVERSATION_ENDED = '__STTS_CONVERSATION_ENDED__';
export const NO_SPEECH = '__STTS_NO_SPEECH__';
export const LISTEN_CONTINUES = '__STTS_LISTEN_CONTINUES__';
export const STOPPED = '__STTS_STOPPED__';
export const BACKGROUND_RESULT = '__STTS_BACKGROUND_RESULT__';
export const SENTINELS = [CONVERSATION_ENDED, NO_SPEECH, LISTEN_CONTINUES, STOPPED, BACKGROUND_RESULT] as const;

// Tool-description notes. The text is the contract agents read; keep it word for word.
export const ENDED_NOTE =
  ` If the reply is exactly ${CONVERSATION_ENDED}, he pressed End conversation: the ` +
  'window has already shut down, so do not speak, do not call stt or tts again, and stop.';

export const NO_SPEECH_NOTE =
  ` If the reply is exactly ${NO_SPEECH}, he has said nothing yet within idleSec: the window ` +
  'is still open and listening. If a background result has finished, relay it with tts (listen=true); ' +
  'otherwise call stt again without speaking. It never means the conversation ended.' +
  ` If the reply is exactly ${BACKGROUND_RESULT}, a background agent just finished: relay its result now with tts (listen=true). ` +
  'Anything he was saying is kept for that listen.';

export const CONTINUES_NOTE =
  ` If the reply is exactly ${LISTEN_CONTINUES}, the listen reached the tool-call time limit, usually ` +
  'because he is still talking. Nothing he said is lost: call stt again at once, without speaking, ' +
  'and it returns everything he said.';

export const NO_SLEEP_NOTE =
  ' Never sleep or block on another tool to wait for him: to wait, call stt again (the default ' +
  `idleSec, ${DEFAULT_IDLE_SEC}, is already the longest), so you answer the moment he stops talking. ` +
  'Use the default idleSec for every normal wait: a background result arrives on its own and interrupts the listen. ' +
  'A message he types into the chat mid-loop (usually something too long to say) is a turn, not an exit: handle it, answer by voice, and go straight back to listening. Typing never ends the conversation.';

export const TURN_NOTE =
  ' Every turn starts with [turn N, heard HH:MM:SS to HH:MM:SS], or [turn N, typed ...] when he typed it. The protocol is listen, answer that exact turn at once, listen: ' +
  'your next call must be tts with listen=true answering turn N; an stt before you answer is refused. If turn N needs no spoken answer ' +
  '(not meant for you, or your answer would only repeat your last reply), call stt with ack=N instead. Do not ask him to finish a sentence: ' +
  'the window already joins a sentence cut mid-thought before returning it, never returns the same speech twice, and keeps speech said ' +
  'while no listen was open for the next listen, so nothing he says is lost. ' +
  'Mark hears a chime when the listen opens (the listen only opens after it, so a reply always comes after the chime and you never speak over it), ' +
  'a tick when his turn is captured, and a two-tone when a background result ends a listen; the window shows the same as a coloured banner. ' +
  'Do not announce "listening" or "got it" yourself.';

export const BARGE_NOTE =
  ' If he types or speaks while you are talking, your speech stops at once and the call returns his message as the next turn, ' +
  'followed by a line saying where it cut you off. Treat that message as an addition or a steer: answer it, then continue the ' +
  'task you were cut off from, unless it explicitly says stop, abort, halt or never mind.';

export const bargeLine = (part: number, sentence: number): string =>
  `(interrupted your speech at part ${part} sentence ${sentence}: treat this as an addition and continue the cut-off task unless it says stop, abort, halt or never mind)`;

export const NOTES = BARGE_NOTE + ENDED_NOTE + NO_SPEECH_NOTE + CONTINUES_NOTE + NO_SLEEP_NOTE + TURN_NOTE;

export const STT_DESCRIPTION = `Show the speech-to-text dialog and return the transcribed text the user spoke.${NOTES}`;

export const TTS_DESCRIPTION =
  'Speak aloud in the voice window. Pass the words as text, or, to read out content that already ' +
  'exists (a story, a chapter, notes, a document), pass file (a local path) or url (plain text or ' +
  'markdown, not an HTML page) instead of copying it into text: the server reads and speaks it, so ' +
  'you do not spend output on it. Markdown files are read without their markup. Long content is ' +
  'read in parts; if the call returns before the end, it says which part to pass next. The Stop ' +
  'button stops the reading and it says where. With ' +
  'listen=true it then opens speech-to-text at once and returns what the user said next, saving ' +
  'a round trip per turn. Open fast: send a short first piece (3 to 6 words) without listen, then ' +
  `the rest in one call with listen. At most two pieces per reply.${NOTES}`;

// A turn whose last word is a connector, filler, preposition, article or lead-in reads
// unfinished. The same list lives in the callbot's turn.mjs (rule 67); the parity test checks it.
export const UNFINISHED_END: ReadonlySet<string> = new Set(
  (
    'and or but so because cause like um uh er erm hmm the a an to of with for from in on at by into about ' +
    'if that which who whose when while where what how as than then also just maybe my your our their his her its ' +
    "is are was were be i we you he she they it's i'm thinking wondering saying guess mean know said"
  ).split(' '),
);

export function readsUnfinished(text: string): boolean {
  const last = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .at(-1);
  return last !== undefined && UNFINISHED_END.has(last);
}

// Reply formats.
const hhmmss = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

// The source is in the prefix: heard (spoken) or typed (keyboard), so the agent knows how it came in.
export const turnReply = (id: number, text: string, startAt: number, endAt: number, typed = false): string =>
  `[turn ${id}, ${typed ? 'typed' : 'heard'} ${hhmmss(startAt)} to ${hhmmss(endAt)}] ${text}`;

export const TURN_PREFIX = /^\[turn (\d+), (?:heard|typed) (\d\d:\d\d:\d\d) to (\d\d:\d\d:\d\d)\] /;

export const unansweredError = (n: number): string =>
  `turn ${n} is unanswered. Answer it now with tts (listen=true), or, if it needs no spoken answer, call stt with ack=${n}.`;

export const SUPERSEDED = 'superseded';

export const readNotes = {
  stopped: (part: number, of: number, where: string): string =>
    of > 1
      ? `He stopped it during part ${part} of ${of}. To resume there, call tts with ${where} and part=${part}.`
      : 'He stopped it.',
  outOfTime: (from: number, to: number, of: number, where: string): string =>
    `Read parts ${from} to ${to} of ${of}. To go on, call tts again with ${where} and part=${to + 1}.`,
  end: (of: number): string => `Read to the end (part ${of} of ${of}).`,
  spoken: 'Spoken.',
} as const;

// /request body. The field shapes double as the MCP input schemas.
export const idleSec = z
  .number()
  .min(0)
  .max(200)
  .optional()
  .describe(
    `Seconds to wait for speech before returning ${NO_SPEECH} (default ${DEFAULT_IDLE_SEC}, 0 waits until he speaks).`,
  );

export const sttShape = {
  idleSec,
  ack: z
    .number()
    .int()
    .optional()
    .describe(
      'Turn id you are deliberately not answering aloud. Without it, an stt right after a returned turn is refused.',
    ),
};

export const ttsShape = {
  text: z.string().optional().describe('The text to speak. Give exactly one of text, file or url.'),
  file: z.string().optional().describe('Local path of a text or markdown file to read aloud, instead of text.'),
  url: z.string().optional().describe('URL of plain text or markdown to read aloud, instead of text.'),
  part: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Start at this part of long content (1 is the start). Use the number a previous call returned.'),
  listen: z.boolean().optional().describe('After speaking, listen and return the next transcript'),
  close: z
    .boolean()
    .optional()
    .describe('Close the voice window after speaking. Use on the last message of a conversation, never with listen.'),
  rate: z
    .number()
    .min(0.5)
    .max(2)
    .optional()
    .describe(
      'Speaking rate for this voice window only, from this call until it closes (1 is normal). Never saved as his default. Omit unless the user asks for a speed change; omitting keeps his saved setting.',
    ),
  volume: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Volume 0 to 1 for this voice window only, from this call until it closes. Never saved as his default. Omit unless the user asks for a volume change; omitting keeps his saved setting.',
    ),
  idleSec,
};

export const RequestBody = z
  .object({
    kind: z.enum(['stt', 'tts']),
    ...ttsShape,
    ack: sttShape.ack,
    who: z.enum(['session', 'agent']).default('session'),
  })
  .refine((b) => b.kind === 'stt' || [b.text, b.file, b.url].filter((v) => v !== undefined).length === 1, {
    message: 'give exactly one of text, file or url',
  });
export type RequestBody = z.infer<typeof RequestBody>;

// WebSocket, page to daemon.
export const PageMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('relisten') }),
  z.object({
    type: z.literal('complete'),
    text: z.string(),
    startAt: z.number(),
    endAt: z.number(),
    // Absent means heard, so an old page still validates. Typed is the keyboard box.
    source: z.enum(['typed', 'heard']).optional(),
    // Set when the message cut the agent's speech off (a barge): where it stopped.
    interrupted: z.object({ part: z.number().int().min(1), sentence: z.number().int().min(1) }).optional(),
  }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('ended') }),
  z.object({ type: z.literal('nospeech') }),
  z.object({ type: z.literal('stopped'), part: z.number().int().min(1) }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('settings'), settings: z.record(z.string(), z.unknown()) }),
]);
export type PageMessage = z.infer<typeof PageMessage>;

// WebSocket, daemon to page.
export const DaemonMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: z.number().int(), body: RequestBody }),
  z.object({ type: z.literal('released'), reason: z.enum(['superseded', 'timeout', 'background']) }),
]);
export type DaemonMessage = z.infer<typeof DaemonMessage>;

export const BAD_MESSAGE_LOG = 'ws bad message';

// Parse a raw frame; anything malformed comes back as undefined so the caller logs
// BAD_MESSAGE_LOG and drops it. Never throws.
export function parseMessage<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : undefined;
}
