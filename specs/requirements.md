# stts requirements

OpenFastTrace register (coverage register T24, mkb-agentops spec 145 "Item format"): one item per promise, never and always line and known limit of `specs/*/spec.md` and `README.md`, with the test or gate that holds it. Traced on every push by Trunk action `trace-on-push`. HARD: a unit test or the `@smoke` e2e set in `npm run gate` refuses the miss. PARTIAL: the `Rationale:` names what is not held (often: the e2e case is outside the smoke set, so it runs only in the full `npm test` before a release). SOFT: history.

### spec:001.1
`req~spec_001.1~1`

> One file, `src/protocol.ts`, holds all of it: the routes, the request shape, the WebSocket messages, the five special replies (sentinels), the notes agents read in the tool descriptions, and the reply formats.

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/protocol.test.ts#tool descriptions contain every note and sentinel
enforcer: repo:test/unit/mcp.test.ts#lists stt and tts with zod schemas and the old descriptions

Tags: HARD, beforeHARD

Needs: impl

### spec:001.2
`req~spec_001.2~1`

> A frame that fails the check is logged as `ws bad message` and dropped; parsing never throws.

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/daemon.test.ts#a bad ws message is logged and dropped

Tags: HARD, beforeHARD

Needs: impl

### spec:001.3
`req~spec_001.3~1`

> Their wording is the contract agents read and is kept word for word.

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/protocol.test.ts#notes word for word
enforcer: repo:test/unit/protocol.test.ts#sentinels

Tags: HARD, beforeHARD

Needs: impl

### spec:001.4
`req~spec_001.4~1`

> A tts call must carry exactly one of `text`, `file` or `url`. Ranges: `idleSec` 0 to 200 (default 200), `rate` 0.5 to 2, `volume` 0 to 1, `part` 1 or more.

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/protocol.test.ts#accepts file or url alone and range edges
enforcer: repo:test/unit/mcp.test.ts#refuses out-of-range input before it reaches the daemon

Tags: HARD, beforeHARD

Needs: impl

### spec:001.5
`req~spec_001.5~1`

> The same word list lives in the callbot (spec 010).

Rationale:
The parity test that compares the two word lists lives in the callbot's repo and gate; this repo's gate checks only its own list.

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/protocol.test.ts#unfinished word list

Tags: PARTIAL, beforePARTIAL

### spec:001.6
`req~spec_001.6~1`

> the daemon and Piper bind 127.0.0.1 only, nothing listens off the machine

Comment:
source: specs/001-protocol-and-sentinels/spec.md
enforcer: repo:test/unit/public-repo.test.ts#the daemon and Piper bind 127.0.0.1 only
enforcer: repo:.trunk/trunk.yaml#run: npm run gate

Tags: HARD, beforeHARD

Needs: impl

### spec:002.1
`req~spec_002.1~1`

> **Dropped:** speech that ended before the last turn ended (stale), or the same text ending within 1 second of the last (duplicate).

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/turns.test.ts#drops a duplicate within 1 s but keeps it after
enforcer: repo:test/unit/turns.test.ts#drops stale speech
enforcer: repo:test/unit/turns.test.ts#ids always rise and the reply carries the turn prefix

Tags: HARD, beforeHARD

Needs: impl

### spec:002.2
`req~spec_002.2~1`

> if the speech reads unfinished (spec 001), the machine waits `STTS_JOIN_SEC` seconds (default 4) for more, up to 3 joins, then returns all of it as one turn. The wait never ends while he is talking again

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/turns.test.ts#joins at most 3 times
enforcer: repo:test/unit/turns.test.ts#the join never ends while he is talking again
enforcer: repo:test/unit/turns.test.ts#reads STTS_JOIN_SEC when no input is given

Tags: HARD, beforeHARD

Needs: impl

### spec:002.3
`req~spec_002.3~1`

> An stt call while it is unanswered gets status 409

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/turns.test.ts#ack gate returns the 409 text until answered or acked
enforcer: repo:test/unit/integration.test.ts#an unanswered stt is the 409 text as the error

Tags: HARD, beforeHARD

Needs: impl

### spec:002.4
`req~spec_002.4~1`

> No-speech, listen-continues and background-result replies are not turns and change nothing.

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/turns.test.ts#no-speech, continues and background-result are not turns

Tags: HARD, beforeHARD

Needs: impl

### spec:002.5
`req~spec_002.5~1`

> **A listen is for the next new turn, never for permission (Mark 2026-11-08).** An agent that announces an action starts that work in the same turn as the tts call and never waits for a go-ahead

Rationale:
Agent behaviour taught by the tool notes, `commands/stts.md` and the stts skill; no test can watch an agent wait for a go-ahead.

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/hook.test.ts#/stts command text carries every sentinel

Tags: PARTIAL, beforePARTIAL

### spec:002.6
`req~spec_002.6~1`

> **Typed turns.** A message typed into the voice window is a turn exactly like heard speech: same prefix, ids, dedupe, join and ack gate.

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/daemon.test.ts#a typed complete returns the turn prefix and logs a typed turn
enforcer: repo:test/unit/daemon.test.ts#a typed message with no listen open is held for the next listen
enforcer: repo:test/e2e/voice.spec.ts#a typed message is returned by stt as a turn', \{ tag: '@smoke'

Tags: HARD, beforeHARD

Needs: impl

### spec:002.7
`req~spec_002.7~1`

> anything he says stops it, no exceptions

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/machine.test.ts#bargeVerdict: echo or barge, fillers barge
enforcer: repo:test/e2e/voice.spec.ts#speaking over the agent cuts it off, a filler included; its own echo does not', \{ tag: '@smoke'

Tags: HARD, beforeHARD

Needs: impl

### spec:002.8
`req~spec_002.8~1`

> **Silence never ends a listen while he is speaking (Mark 2026-11-08 22:03).**

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/daemon.test.ts#a page nospeech while he is speaking is not silence

Tags: HARD, beforeHARD

Needs: impl

### spec:002.9
`req~spec_002.9~1`

> One or two words over the agent's speech that include stop, wait, no, pause or enough are a barge even when the agent's own sentence held the same word

Comment:
source: specs/002-turns/spec.md
enforcer: repo:test/unit/machine.test.ts#bargeVerdict: echo or barge, fillers barge

Tags: HARD, beforeHARD

Needs: impl

### spec:002.10
`req~spec_002.10~1`

> Holds turn state in memory only; a daemon restart starts again at turn 1.

Rationale:
Known limit: turn numbers are not kept across a daemon restart.

Comment:
source: specs/002-turns/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:003.1
`req~spec_003.1~1`

> A new request replaces the old one: the old caller gets `504 superseded`, and if the old one was a listen the page is told `released{superseded}` first. "Busy" is never returned.

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a newer request supersedes the old one with 504 and released
enforcer: repo:test/unit/daemon.test.ts#1000 supersedes leave no leaked slot

Tags: HARD, beforeHARD

Needs: impl

### spec:003.2
`req~spec_003.2~1`

> A listen that reaches it sends `released{timeout}` and returns `__STTS_LISTEN_CONTINUES__`; speech that arrives after is kept and given to the next listen.

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a listen past the budget continues, and the carry joins the next listen

Tags: HARD, beforeHARD

Needs: impl

### spec:003.3
`req~spec_003.3~1`

> with no open request (after a Stop, a restart or a hand-off) the words are held and returned by the next listen, never dropped

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#speech with no listen open is held for the next listen
enforcer: repo:test/unit/daemon.test.ts#speech while a speak-only tts is open is held, not lost
enforcer: repo:test/unit/daemon.test.ts#/held hands held speech to the steer hook once, then has none

Tags: HARD, beforeHARD

Needs: impl

### spec:003.4
`req~spec_003.4~1`

> A request is sent to the page once

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#never replays: a tts with listen resends only its listen

Tags: HARD, beforeHARD

Needs: impl

### spec:003.5
`req~spec_003.5~1`

> **End is never lost:** `ended` writes `<data>/ended` first

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#an End pressed with no call open is kept for the next call, once
enforcer: repo:test/unit/daemon.test.ts#page ended answers the conversation-ended sentinel
enforcer: repo:test/unit/daemon.test.ts#a closed window is not an End

Tags: HARD, beforeHARD

Needs: impl

### spec:003.6
`req~spec_003.6~1`

> `close=true` is honoured only from `who=session`; from `who=agent` it is ignored.

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#close from a helper agent is ignored
enforcer: repo:test/unit/daemon.test.ts#a session tts with close shuts the window once it has spoken

Tags: HARD, beforeHARD

Needs: impl

### spec:003.7
`req~spec_003.7~1`

> If no page connects within 15 s the daemon logs `window open timed out` and the next request launches again.

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a window that never connects times out after 15 s and the next send relaunches
enforcer: repo:test/unit/daemon.test.ts#a launcher that throws, even synchronously, logs once

Tags: HARD, beforeHARD

Needs: impl

### spec:003.8
`req~spec_003.8~1`

> The wait starts at 2 s and doubles on each try up to 60 s, so a crash loop never spins

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a window killed mid-listen reopens, the listen resumes, and a crash loop backs o

Tags: HARD, beforeHARD

Needs: impl

### spec:003.9
`req~spec_003.9~1`

> If the port is taken, the new process pings it and exits 0 when a live daemon answers `ok`, otherwise 1.

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a second instance exits 0 when the port answers ok

Tags: HARD, beforeHARD

Needs: impl

### spec:003.10
`req~spec_003.10~1`

> A listening `tts` or an `stt` from the gateway (`who=agent`: Codex, Grok, or Claude through `stts_tts`) is a voice loop and takes the barge as its turn

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a gateway voice loop \(who=agent, listen\) takes the barge as its turn
enforcer: repo:test/unit/daemon.test.ts#a barge never settles into a subagent request

Tags: HARD, beforeHARD

Needs: impl

### spec:003.11
`req~spec_003.11~1`

> The barge line names the cut point and, on its own next line `unspoken: <words>`, gives word for word what he never heard

Comment:
source: specs/003-daemon-slot-and-budget/spec.md
enforcer: repo:test/unit/daemon.test.ts#a barge returns the unspoken rest word for word, from the cut sentence on
enforcer: repo:test/unit/daemon.test.ts#a barge with a word timing returns the unspoken rest from that word
enforcer: repo:test/unit/daemon.test.ts#a barge before any audio played flags the reply as not spoken

Tags: HARD, beforeHARD

Needs: impl

### spec:004.1
`req~spec_004.1~1`

> The daemon loads it, cuts it into parts of at most 1000 characters, speaks them in order, and says where to resume when it stops early.

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/unit/sentences.test.ts#1000-character boundary
enforcer: repo:test/unit/integration.test.ts#reads a file part by part to the end
enforcer: repo:test/unit/integration.test.ts#starts at part N and reports a stop with where to resume

Tags: HARD, beforeHARD

Needs: impl

### spec:004.2
`req~spec_004.2~1`

> Markdown (`.md`, `.markdown`, `.mdx`, or a markdown content type or URL) has its markup removed. Plain text is left alone. An HTML page is refused.

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/unit/integration.test.ts#strips markdown from a .md file
enforcer: repo:test/unit/integration.test.ts#reads a url and refuses an HTML page

Tags: HARD, beforeHARD

Needs: impl

### spec:004.3
`req~spec_004.3~1`

> `part=N` starts at part N; a part past the end is refused with the part count.

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/unit/integration.test.ts#a part past the end is an error

Tags: HARD, beforeHARD

Needs: impl

### spec:004.4
`req~spec_004.4~1`

> A sentence longer than the limit is cut only at a clause mark

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/unit/sentences.test.ts#a long sentence is cut only at a clause mark
enforcer: repo:test/unit/sentences.test.ts#a token with no spaces is hard-cut

Tags: HARD, beforeHARD

Needs: impl

### spec:004.5
`req~spec_004.5~1`

> A call's `rate` and `volume` hold for the window until it closes or the slider moves, never saved.

Rationale:
Held by the e2e case "a tts rate reaches the browser voice and holds for the window", which is outside the `@smoke` set: it runs in the full `npm test` before a release, not in the push gate.

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/e2e/voice.spec.ts#a tts rate reaches the browser voice and holds for the window

Tags: PARTIAL, beforePARTIAL

### spec:004.6
`req~spec_004.6~1`

> Barge-in is the text path's: every part is an ordinary tts in the slot

Comment:
source: specs/004-read-aloud/spec.md
enforcer: repo:test/unit/daemon.test.ts#a spoken barge cuts a file read-aloud off like a text tts
enforcer: repo:test/unit/daemon.test.ts#a Stop in the gap between two read-aloud parts stops the reading

Tags: HARD, beforeHARD

Needs: impl

### spec:004.7
`req~spec_004.7~1`

> | Safety | Read-only: the file is read, never written | least privilege | code review in spec |

Rationale:
No test proves the read path never writes; held by reading `src/daemon.ts`.

Comment:
source: specs/004-read-aloud/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:005.1
`req~spec_005.1~1`

> Mute is absolute: once Mark mutes, nothing but his own click or key turns the mic back on.

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#mute: nothing restarts the mic while paused
enforcer: repo:test/unit/machine.test.ts#untrusted pause and resume are ignored
enforcer: repo:test/unit/machine.test.ts#paused stays paused through speech: no mic during playback

Tags: HARD, beforeHARD

Needs: impl

### spec:005.2
`req~spec_005.2~1`

> A one-off notice (`notice` on the request, set by the daemon, spec 010) never starts the mic

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#a one-off notice speaks with the mic off
enforcer: repo:test/unit/daemon.test.ts#a notice can never close a conversation window

Tags: HARD, beforeHARD

Needs: impl

### spec:005.3
`req~spec_005.3~1`

> Once a listen has opened, the mic stays on for good

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#regression 2026-10-16: a released listen keeps the mic on
enforcer: repo:test/unit/machine.test.ts#regression 2026-10-16: a typed turn keeps the mic on
enforcer: repo:test/unit/machine.test.ts#the mic stays on after a finished-sounding turn

Tags: HARD, beforeHARD

Needs: impl

### spec:005.4
`req~spec_005.4~1`

> Sends after 0.8 s, or 1.2 s if the speech reads unfinished

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#autosend on speechend: 0.8 s, or 1.2 s when unfinished
enforcer: repo:test/unit/machine.test.ts#1 to 3 words wait SHORT_HOLD_MS
enforcer: repo:test/unit/machine.test.ts#never ends a turn while his voice is on the mic, for up to 6 s

Tags: HARD, beforeHARD

Needs: impl

### spec:005.5
`req~spec_005.5~1`

> A running recogniser is never aborted for silence or wordless sound

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#the watchdog never aborts a running recogniser for silence
enforcer: repo:test/unit/machine.test.ts#wordless speech never restarts a running recogniser
enforcer: repo:test/unit/machine.test.ts#errors restart at once, then back off to at most 2 s

Tags: HARD, beforeHARD

Needs: impl

### spec:005.6
`req~spec_005.6~1`

> A final is the agent's own voice, dropped with `echo discarded` logged once per sentence

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#isEcho: mis-heard playback is echo, real barge-ins pass
enforcer: repo:test/unit/echo-regression.test.ts#a garbled echo of the last reply is recognised as echo
enforcer: repo:test/e2e/voice.spec.ts#its own echo does not', \{ tag: '@smoke'

Tags: HARD, beforeHARD

Needs: impl

### spec:005.7
`req~spec_005.7~1`

> Known ceiling: an echo garbled past half slips through and a barge that repeats the sentence is dropped.

Rationale:
Known limit of the text echo check.

Comment:
source: specs/005-page-machine-and-mute/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:005.8
`req~spec_005.8~1`

> every tts, Stop, Skip and barge cuts the old speech off through one path

Rationale:
Held by e2e "a new tts mid-speech cuts the old speech off" in `zz-regressions.spec.ts`, outside the `@smoke` set (full `npm test` only); the unit side is "stop empties the speech queue so the next tts plays".

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#stop empties the speech queue so the next tts plays
enforcer: repo:test/e2e/zz-regressions.spec.ts#a new tts mid-speech cuts the old speech off

Tags: PARTIAL, beforePARTIAL

### spec:005.9
`req~spec_005.9~1`

> Muting sends what he said before it and drops only what he says while muted

Rationale:
No unit or smoke case sends words at mute and reads the `complete`; the mute half (nothing restarts the mic) is HARD in spec:005.1.

Comment:
source: specs/005-page-machine-and-mute/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:005.10
`req~spec_005.10~1`

> The page posts `ended` with `idle: true`; the daemon answers an open call `__STTS_IDLE_ENDED__` (not `__STTS_CONVERSATION_ENDED__`), closes the window and remembers nothing

Rationale:
The daemon side is tested; the page's idle timer (15 min default, every 15 s check) has no test.

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/daemon.test.ts#an idle end answers IDLE_ENDED and is never remembered

Tags: PARTIAL, beforePARTIAL

### spec:005.11
`req~spec_005.11~1`

> A barge carries every word already heard for the turn before its final

Comment:
source: specs/005-page-machine-and-mute/spec.md
enforcer: repo:test/unit/machine.test.ts#regression 2026-10-16: a barge carries the words heard before it
enforcer: repo:test/unit/daemon.test.ts#held words are never replaced, and a barge carries them

Tags: HARD, beforeHARD

Needs: impl

### spec:006.1
`req~spec_006.1~1`

> the screenshot check covers 200, 240, 390, 462x689 (his window), 800x320 and 1600x600 and fails on any overlap.

Rationale:
The overlap check is `test/screenshots/shoot.ts`, run by hand; the push gate runs only `lyrics.spec.ts` (`@smoke`), which checks the lit line at five sizes, not overlap.

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/e2e/lyrics.spec.ts#the playing line is in view at

Tags: PARTIAL, beforePARTIAL

### spec:006.2
`req~spec_006.2~1`

> the line playing now is in full colour and every other line is dimmed; when a clip ends the next line lights

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/e2e/lyrics.spec.ts#tag: '@smoke'

Tags: HARD, beforeHARD

Needs: impl

### spec:006.3
`req~spec_006.3~1`

> `test/unit/brand-tokens.test.ts` refuses a raw colour or palette class in `web/*.tsx` (vendored `web/components/ui` exempt).

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/unit/brand-tokens.test.ts#no raw colour or palette class outside the token file
enforcer: repo:test/unit/brand-tokens.test.ts#every turn hue the page reads is a token

Tags: HARD, beforeHARD

Needs: impl

### spec:006.4
`req~spec_006.4~1`

> Stop and End only act on a real click (`isTrusted`). No spoken word operates the window.

Rationale:
Pause and resume are unit-tested; the End click is held by e2e "an untrusted End click is ignored", outside the `@smoke` set.

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/unit/machine.test.ts#untrusted pause and resume are ignored
enforcer: repo:test/e2e/voice.spec.ts#an untrusted End click is ignored

Tags: PARTIAL, beforePARTIAL

### spec:006.5
`req~spec_006.5~1`

> Off (HeadphoneOff icon, "Barge-in off (mic muted while the agent speaks)"): the mic track is muted and the recogniser stopped for the whole speech, and the listen opens when it ends

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/unit/machine.test.ts#barge-in off: no mic while the agent speaks, the listen opens after it

Tags: HARD, beforeHARD

Needs: impl

### spec:006.6
`req~spec_006.6~1`

> | speaker | mic unplugged | return visit | open mic gone | falls back to the default mic |

Rationale:
The journeys table: 3 of its 7 rows (a listen, a typed turn, speaking over the agent) run in the `@smoke` set of the push gate; the mic unplug, pause mid-sentence, End and narrow-width rows run only in the full `npm test`.

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/e2e/voice.spec.ts#a listen produces a turn', \{ tag: '@smoke'
enforcer: repo:test/e2e/zz-regressions.spec.ts#a mic plugged in later is listed

Tags: PARTIAL, beforePARTIAL

### spec:006.7
`req~spec_006.7~1`

> An agent never closes or kills the stts window on its own (Mark 2026-10-13): he may be using it from his phone

Rationale:
Agent behaviour; the daemon ignores a helper's close (spec:003.6), but nothing stops an agent killing the Chrome window by other means.

Comment:
source: specs/006-screen/spec.md
enforcer: repo:test/unit/daemon.test.ts#close from a helper agent is ignored

Tags: PARTIAL, beforePARTIAL

### spec:006.8
`req~spec_006.8~1`

> `index.html` and `manifest.webmanifest` link them with a `?v=N` that is bumped with every icon change

Rationale:
No check pairs an icon change with a `?v=N` bump.

Comment:
source: specs/006-screen/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:007.1
`req~spec_007.1~1`

> The hook always exits 0, even when the daemon is down or slow. With no open listen, `/notify` does nothing; nothing is latched for a later listen.

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/hook.test.ts#hook exits 0 fast with the daemon down
enforcer: repo:test/unit/daemon.test.ts#/notify with no listen open changes nothing

Tags: HARD, beforeHARD

Needs: impl

### spec:007.2
`req~spec_007.2~1`

> A tts with listen whose speech is still playing is never cut short: the background result is held on that call and returned the moment its speech ends and its listen opens

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/daemon.test.ts#/notify during a tts with listen waits for the speech to end

Tags: HARD, beforeHARD

Needs: impl

### spec:007.3
`req~spec_007.3~1`

> The hook skips an agent that runs inside a Workflow

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/hook.test.ts#only a stop that reaches the session as a task-notification pokes the daemon

Tags: HARD, beforeHARD

Needs: impl

### spec:007.4
`req~spec_007.4~1`

> Only a write after the launch counts: a resumed run reuses its file, which still holds the old status

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/daemon.test.ts#/notify\?watch releases the listen once the workflow state file says completed

Tags: HARD, beforeHARD

Needs: impl

### spec:007.5
`req~spec_007.5~1`

> There is no version field; the commit is the version.

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/hook.test.ts#plugin manifest has the fields Claude Code needs and no version

Tags: HARD, beforeHARD

Needs: impl

### spec:007.6
`req~spec_007.6~1`

> A background result never cuts off his speech and never loses his words (Mark 2026-11-08).

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/daemon.test.ts#a background result waits while he is speaking: his turn first, then the result
enforcer: repo:test/unit/daemon.test.ts#a background result held while he spoke goes when he stops with no turn

Tags: HARD, beforeHARD

Needs: impl

### spec:007.7
`req~spec_007.7~1`

> every `/notify` carries `session=<session_id>` (SubagentStop, Workflow watch) and is ignored when it differs from the listening session

Comment:
source: specs/007-plugin-shell-and-hooks/spec.md
enforcer: repo:test/unit/daemon.test.ts#a wake from another Claude session never ends this listen

Tags: HARD, beforeHARD

Needs: impl

### spec:008.1
`req~spec_008.1~1`

> Input schemas and descriptions come straight from `src/protocol.ts` (spec 001), so the notes and sentinels in the descriptions cannot drift.

Comment:
source: specs/008-mcp-server-and-client/spec.md
enforcer: repo:test/unit/mcp.test.ts#lists stt and tts with zod schemas and the old descriptions
enforcer: repo:test/unit/protocol.test.ts#tool descriptions contain every note and sentinel

Tags: HARD, beforeHARD

Needs: impl

### spec:008.2
`req~spec_008.2~1`

> `STTS_WHO=agent` marks every call as from a helper agent (its `close` is ignored); anything else means `session`.

Comment:
source: specs/008-mcp-server-and-client/spec.md
enforcer: repo:test/unit/mcp.test.ts#agent marks every call who=agent; unset is session

Tags: HARD, beforeHARD

Needs: impl

### spec:008.3
`req~spec_008.3~1`

> E -->|ECONNRESET, ECONNREFUSED or EPIPE| F[start daemon, retry once]

Comment:
source: specs/008-mcp-server-and-client/spec.md
enforcer: repo:test/unit/client.test.ts#respawns and retries once when the daemon drops the connection
enforcer: repo:test/unit/client.test.ts#does not retry twice
enforcer: repo:test/unit/client.test.ts#daemonGone only matches the three codes

Tags: HARD, beforeHARD

Needs: impl

### spec:008.4
`req~spec_008.4~1`

> B -->|other install, no window| C[POST /api/shutdown then start ours]

Comment:
source: specs/008-mcp-server-and-client/spec.md
enforcer: repo:test/unit/client.test.ts#retires a stale-dir daemon with no window open and respawns
enforcer: repo:test/unit/client.test.ts#leaves a stale-dir daemon alone while its window is open

Tags: HARD, beforeHARD

Needs: impl

### spec:008.5
`req~spec_008.5~1`

> dist is build output, so rebuild with `npx tsdown && npx vite build` and grep it for `<<<<<<<` before committing.

Comment:
source: specs/008-mcp-server-and-client/spec.md
enforcer: repo:package.json#npm run build && npm run e2e:smoke && git diff --exit-code -- dist

Tags: HARD, beforeHARD

Needs: impl

### spec:009.1
`req~spec_009.1~1`

> the push gate runs `npm run build` and then `git diff --exit-code -- dist`, so a stale `dist/` fails the build.

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:package.json#git diff --exit-code -- dist
enforcer: repo:test/unit/build.test.ts#builds dist/mcp.js, dist/daemon.js, dist/web/ and dist/earcon/

Tags: HARD, beforeHARD

Needs: impl

### spec:009.2
`req~spec_009.2~1`

> Nothing in `src/`, `web/` or `scripts/` may need `A:\`, mkb-agentops, mkb-winops, a vault or any account of ours.

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:test/unit/public-repo.test.ts#no code line in src, web or scripts needs our drive, ops repos or account folders

Tags: HARD, beforeHARD

Needs: impl

### spec:009.3
`req~spec_009.3~1`

> Dependencies are pinned to exact versions; Renovate keeps them current (`package.json`).

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:test/unit/public-repo.test.ts#every dependency is pinned to an exact version
enforcer: repo:renovate.json
enforcer: ext:Renovate app on the GitHub repo opens update pull requests

Tags: HARD, beforeHARD

Needs: impl

### spec:009.4
`req~spec_009.4~1`

> House-only behaviour is opt-in through a setting (env, `config.json`) that our setup writes, never a default in code.

Rationale:
Judged by review; the public-repo test catches only literal house paths and names (spec:009.2), not a house default written another way.

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:test/unit/public-repo.test.ts#no code line in src, web or scripts needs our drive

Tags: PARTIAL, beforePARTIAL

### spec:009.5
`req~spec_009.5~1`

> User-facing text (README, errors, page messages, logs) tells a stranger what to do with stts alone, never "run setup-stts.ps1".

Rationale:
Judged by reading; no check scans user-facing strings for house steps.

Comment:
source: specs/009-install-and-upgrade/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:009.6
`req~spec_009.6~1`

> A new part the daemon needs (a package, model or file) is bundled into `dist/` or fetched by the daemon itself in the same commit.

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:package.json#git diff --exit-code -- dist

Rationale:
A new npm package is inlined by the build and the stale-`dist` check holds it; a new model or file outside the bundle is judged by review.

Tags: PARTIAL, beforePARTIAL

### spec:009.7
`req~spec_009.7~1`

> No secret, personal path, account name or private host in the repository

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:test/unit/public-repo.test.ts#needs our drive, ops repos or account folders
enforcer: repo:.trunk/trunk.yaml#trunk check --ci --no-fix -t git-commit

Rationale:
Secrets: gitleaks in the commit and push checks. Paths and account names: the public-repo test over code; comments and specs that name our setup are allowed by the rule and are read by review.

Tags: PARTIAL, beforePARTIAL

### spec:009.8
`req~spec_009.8~1`

> Data a user already has (profile, settings, `config.json`) survives an upgrade; a moved folder is migrated in place.

Rationale:
The migration lives in mkb-agentops `setup-stts.ps1` for our machines; no test in this repo upgrades a data folder.

Comment:
source: specs/009-install-and-upgrade/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:009.9
`req~spec_009.9~1`

> Before the push: the unit tests, and a start of the built `node dist/daemon.js` with `STTS_DATA_DIR` pointed at an empty temp folder that logs `daemon start` and nothing else (nothing assumed present).

Rationale:
The unit tests run in the push gate; the empty-folder start and the `git archive` check are run by hand.

Comment:
source: specs/009-install-and-upgrade/spec.md
enforcer: repo:package.json#vitest run

Tags: PARTIAL, beforePARTIAL

### spec:010.1
`req~spec_010.1~1`

> The gateway entry lives in mkb-agentops and points at `dist/mcp.js` with `STTS_WHO=agent`, so a helper agent cannot close Mark's window.

Comment:
source: specs/010-gateway-and-callbot-sharing/spec.md
enforcer: owner:mkb-agentops/mcp-servers/stts.json#"STTS_WHO": "agent"
enforcer: repo:test/unit/daemon.test.ts#close from a helper agent is ignored

Tags: HARD, beforeHARD

Needs: impl

### spec:010.2
`req~spec_010.2~1`

> The callbot imports `src/sentences.ts`. Its `turn.mjs` keeps the same `readsUnfinished` word list; a parity test checks they match.

Rationale:
The parity test runs in the callbot's gate, not here; a change here is paired with the callbot by the person making it (spec 010 "How to run").

Comment:
source: specs/010-gateway-and-callbot-sharing/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:010.3
`req~spec_010.3~1`

> Idle end (spec 005) is stts only: a meeting has long quiet stretches by design, so the callbot never leaves on silence

Rationale:
A parity decision recorded in the callbot's spec 004 table; nothing here can check the callbot.

Comment:
source: specs/010-gateway-and-callbot-sharing/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:011.1
`req~spec_011.1~1`

> The push hook runs `npm run gate`: `trunk check --ci --all`, biome, tsc, spec lint, vitest, build, the Playwright smoke set (`npm run e2e:smoke`, the tests tagged `@smoke`), then `git diff --exit-code -- dist`

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:.trunk/trunk.yaml#run: npm run gate
enforcer: repo:package.json#"gate": "trunk check --ci --no-fix --all && biome ci . && tsc --noEmit && markdownlint-cli2 && vitest run

Tags: HARD, beforeHARD

Needs: impl

### spec:011.2
`req~spec_011.2~1`

> rule MD043 makes every `specs/*/spec.md` have exactly the five sections in order.

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:.markdownlint-cli2.jsonc#"MD043"

Tags: HARD, beforeHARD

Needs: impl

### spec:011.3
`req~spec_011.3~1`

> TypeScript with `@tsconfig/strictest`, no `any` and no suppressions.

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:tsconfig.json#@tsconfig/strictest
enforcer: repo:package.json#tsc --noEmit

Tags: HARD, beforeHARD

Needs: impl

### spec:011.4
`req~spec_011.4~1`

> The full browser suite (`npm test`, about 1.5 minutes) runs by hand before a release or after a change to the page or daemon

Rationale:
Known limit, decided 2026-11-08: only the `@smoke` e2e cases run in the push gate; the other e2e cases depend on someone running `npm test`.

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:package.json#"test": "markdownlint-cli2 && vitest run && npm run build && playwright test"

Tags: PARTIAL, beforePARTIAL

### spec:011.5
`req~spec_011.5~1`

> no GitHub Actions (removed 2026-10-23 on Mark's order)

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: owner:mkb-agentops/.rulesync/hooks/ban-github-actions.mjs

Tags: HARD, beforeHARD

Needs: impl

### spec:011.6
`req~spec_011.6~1`

> Both are custom actions with `--ci`, because Trunk's stock hook actions only warn when no terminal is attached. A failure refuses the push.

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:.trunk/trunk.yaml#trunk check --ci --no-fix -t git-commit
enforcer: repo:.trunk/trunk.yaml#run: npm run gate

Tags: HARD, beforeHARD

Needs: impl

### spec:011.7
`req~spec_011.7~1`

> Budgets only go down.

Comment:
source: specs/011-tests-and-ci/spec.md
enforcer: repo:.trunk/trunk.yaml#speed-gate.mjs --clock-end markkennethbadilla/stts
enforcer: owner:mkb-agentops/gate-budgets.json#markkennethbadilla/stts

Tags: HARD, beforeHARD

Needs: impl

### spec:012.1
`req~spec_012.1~1`

> These lines are searched for and kept word for word:

Comment:
source: specs/012-logging/spec.md
enforcer: repo:test/unit/page-log.test.ts#mic start and mic restart #N: reason reach daemon.log word for word
enforcer: repo:test/unit/daemon.test.ts#page log lines are prefixed with page

Rationale:
Two of the table's lines (`page mic start`, `page mic restart #N: reason`) and the `page` prefix are tested; the other lines are kept by review.

Tags: PARTIAL, beforePARTIAL

### spec:012.2
`req~spec_012.2~1`

> What he says is never logged. Clip lines carry only the first 30 characters of the agent's speech.

Rationale:
No test reads `daemon.log` after a turn for his words; the turn-sent line logs word counts only by construction.

Comment:
source: specs/012-logging/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:012.3
`req~spec_012.3~1`

> There is no rotation.

Rationale:
Known limit: `daemon.log` grows without a cap.

Comment:
source: specs/012-logging/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:013.1
`req~spec_013.1~1`

> It hands off only while a listen is open

Comment:
source: specs/013-live-update/spec.md
enforcer: repo:test/unit/live-update.test.ts#with the window open, it hands off only while a plain listen is open
enforcer: repo:test/unit/live-update.test.ts#idle with no window, it hands off at once
enforcer: repo:test/unit/live-update.test.ts#a tts with listen counts once the page reports its speech done

Tags: HARD, beforeHARD

Needs: impl

### spec:013.2
`req~spec_013.2~1`

> When main is ahead it runs Claude Code's own updater at once

Comment:
source: specs/013-live-update/spec.md
enforcer: repo:test/unit/live-update.test.ts#pulls at once when main is ahead of the installed commit, never when it matches

Tags: HARD, beforeHARD

Needs: impl

### spec:013.3
`req~spec_013.3~1`

> The installed daemon sends `X-Stts-Latest: 1` and refuses `/api/shutdown` (409)

Comment:
source: specs/013-live-update/spec.md
enforcer: repo:test/unit/live-update.test.ts#the installed daemon refuses an older client shutdown; another install accepts it

Tags: HARD, beforeHARD

Needs: impl

### spec:013.4
`req~spec_013.4~1`

> A hand-off or redirect never goes to an older build (log `live update: refused a downgrade to DIR`).

Rationale:
No unit case offers an older build and reads the refusal; the missing or broken install case is tested.

Comment:
source: specs/013-live-update/spec.md
enforcer: repo:test/unit/live-update.test.ts#stays when the install is missing, has no daemon.js, or the file is bad

Tags: PARTIAL, beforePARTIAL

### spec:013.5
`req~spec_013.5~1`

> The agent's own MCP client is not replaced live

Rationale:
Known limit: the thin client stays the one the session began with; the daemon carries the behaviour.

Comment:
source: specs/013-live-update/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:014.1
`req~spec_014.1~1`

> Words still forming when a session ends are turned into a final result and handed to the page before the restart

Comment:
source: specs/014-speech-engine/spec.md
enforcer: repo:test/unit/chrome-recognition.test.ts#restarts when Chrome ends a session and keeps the words that were still forming

Tags: HARD, beforeHARD

Needs: impl

### spec:014.2
`req~spec_014.2~1`

> `no-speech`, `aborted` and `network` errors only end a session and restart it; any other error (`not-allowed`, `audio-capture`, a missing recogniser) goes to the page and ends the wrapper.

Comment:
source: specs/014-speech-engine/spec.md
enforcer: repo:test/unit/chrome-recognition.test.ts#a no-speech error restarts; a fatal one ends the recogniser
enforcer: repo:test/unit/chrome-recognition.test.ts#abort ends it once and starts no new session

Tags: HARD, beforeHARD

Needs: impl

### spec:014.3
`req~spec_014.3~1`

> a failed clip is spoken by the browser voice instead and logged.

Rationale:
No unit or smoke case fails a Piper clip and reads the fallback; Piper is absent in the test run, so the e2e always uses the fake browser voice.

Comment:
source: specs/014-speech-engine/spec.md

Tags: PARTIAL, beforePARTIAL

### spec:014.4
`req~spec_014.4~1`

> `pickVoice` uses the voice saved in settings if the browser has it, else the best English one

Rationale:
Known gap: `pickVoice` in `web/App.tsx` has no unit case.

Comment:
source: specs/014-speech-engine/spec.md

Tags: PARTIAL, beforePARTIAL

### readme.1
`req~readme.1~1`

> A removed or renamed tool, argument, sentinel or setting is listed under this heading in the same commit, with what replaces it

Rationale:
Held in part: a sentinel or note change fails `protocol.test.ts` against the fixture; no check pairs a removal with a README line.

Comment:
source: README.md
enforcer: repo:test/unit/protocol.test.ts#sentinels

Tags: PARTIAL, beforePARTIAL

### readme.2
`req~readme.2~1`

> Each choice, the option rejected and why. A new one is added here in the change that makes it.

Rationale:
A writing convention for design decisions; judged by reading.

Comment:
source: README.md

Tags: PARTIAL, beforePARTIAL

### history.1
`req~history.1~1`

> Two bugs on 2026-10-05 (an undefined name that crashed the page, and mute being undone by a restart) reached Mark because nothing checked them.

Rationale:
History: why the tests exist.

Comment:
source: specs/011-tests-and-ci/spec.md

Tags: SOFT, beforeSOFT

### history.2
`req~history.2~1`

> This replaces the local engine that was built on 2026-10-07

Rationale:
History: the removed local engine.

Comment:
source: specs/014-speech-engine/spec.md

Tags: SOFT, beforeSOFT
