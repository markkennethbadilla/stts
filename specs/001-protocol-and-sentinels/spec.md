# Protocol and sentinels

## What it does

Defines every message that passes between the agent's tools, the background service (the daemon) and the voice window. One file, `src/protocol.ts`, holds all of it: the routes, the request shape, the WebSocket messages, the five special replies (sentinels), the notes agents read in the tool descriptions, and the reply formats.

## Why it exists

Three programs must agree on the same words. When each kept its own copy, they drifted and broke the conversation. One definition, checked by a schema library (zod), means a wrong message is caught and logged instead of crashing anything.

## How it works

The daemon listens on `127.0.0.1`, port `STTS_PORT` or 15986 by default.

| Route | What it does |
| --- | --- |
| `GET /` | The voice window page |
| `GET /api/ping` | Answers `ok` plus an `X-Stts-Dir` header naming the install folder |
| `POST /request` | One stt or tts call; answers plain text |
| `POST /api/shutdown` | Stops the daemon |
| `GET /barge` | Answers `{text:"", open}`; `open` is true while a window is connected |
| `POST /notify` | A background helper finished (spec 007) |
| `GET /earcon/:name.ogg` | The short sounds |
| `POST /voice/clip` | `{text, voice, rate}` in, Piper's `audio/wav` out; the page speaks through it so it needs one origin |
| WebSocket `/ws` | The live link to the page |

`/request` answers 200 with the reply text. Any other status is an error whose body is the error text: 400 bad input, 409 unanswered turn (spec 002), 504 `superseded` (spec 003).

The request body is `{kind, text|file|url, part, listen, close, idleSec, rate, volume, ack, who}`. A tts call must carry exactly one of `text`, `file` or `url`. Ranges: `idleSec` 0 to 200 (default 200), `rate` 0.5 to 2, `volume` 0 to 1, `part` 1 or more. `who` is `session` by default. The MCP tool inputs (spec 008) are built from these same field definitions.

WebSocket messages, one checked list per direction:

- Page to daemon: `ready`, `relisten` (sent on unmute: the daemon resends an open listen, never a tts), `listening` (the light went green: a tts with listen has finished speaking), `complete{text,startAt,endAt,source?,interrupted?}` (`source` is `typed` or `heard`, absent means heard so an old page still validates; `interrupted{part,sentence}` marks a barge), `cancel`, `close`, `ended`, `nospeech`, `stopped{part}`, `log{line}`, `settings`.
- Daemon to page: `request{id,body}`, `released{reason}` where reason is `superseded`, `timeout` or `background`.

A frame that fails the check is logged as `ws bad message` and dropped; parsing never throws.

Sentinels are replies that are exactly one special word and mean a signal, not speech:

| Sentinel | Meaning |
| --- | --- |
| `__STTS_CONVERSATION_ENDED__` | He pressed End conversation; stop |
| `__STTS_NO_SPEECH__` | Nothing said within `idleSec`; listen again |
| `__STTS_LISTEN_CONTINUES__` | The listen hit the time budget; call stt again, nothing is lost |
| `__STTS_STOPPED__` | He pressed Stop during speech (followed by the part number) |
| `__STTS_BACKGROUND_RESULT__` | A background helper finished; relay its result |

The tool descriptions carry fixed notes (`ENDED_NOTE`, `NO_SPEECH_NOTE`, `CONTINUES_NOTE`, `NO_SLEEP_NOTE`, `TURN_NOTE`). Their wording is the contract agents read and is kept word for word.

`readsUnfinished(text)` says whether speech ends on a connector, filler or lead-in word ("and", "um", "the", "thinking" and so on). The same word list lives in the callbot (spec 010).

## What it reads and writes

Nothing on disk. It is pure definitions imported by the daemon, the MCP server, the client and the page.

## How to run, check and hand over

`test/unit/protocol.test.ts` checks round trips, the sentinels and reply formats against `test/fixtures/old-contract.json` (captured from the old repo), and the `readsUnfinished` word list. Run `npm test`. To change any wording, change it here only, update the fixture on purpose, and update the callbot in the same session.
