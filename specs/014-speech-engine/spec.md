# Speech engine

## What it does

Turns what Mark says into text on this computer, with no network. The voice window sends the daemon its microphone audio; the daemon finds where speech starts and stops and writes down each stretch of speech. The page receives the text exactly as it used to receive it from Chrome, so the turn rules (specs 002 and 005), the End button and every reply format are unchanged.

## Why it exists

Chrome's built-in speech recognition lost his words (Mark 2026-10-07): sessions that started late cut off the start of his sentences, restarts threw away speech in flight, and a two-minute turn came back as one word. Mark: "replace the stt with something else that works and doesn't drop my speech". Chosen after a search (2026-10-07): sherpa-onnx (k2-fsa, Apache-2.0, about 15,000 stars, active), the most-used local engine that does both voice detection and recognition from Node with no Python. The model is NVIDIA Parakeet TDT 0.6B v2 (int8). On two minutes each of two Filipino-accented call-centre recordings (AIxBlock set, human transcripts) it scored 12.8% and 30.5% word error, most of the second from number formatting ("2019" for "twenty nineteen"); a two-minute recording decoded in about 2 seconds.

## How it works

- **Page.** One echo-cancelled, noise-suppressed microphone stream is opened once (spec 006) and fed through an AudioWorklet (`public/pcm-worklet.js`) at 16 kHz, in 100 ms blocks, over a WebSocket to the daemon's `/asr`. Audio captured while that socket is down is kept and sent when it reconnects. `web/daemonRecognition.ts` has the shape of Chrome's `SpeechRecognition`, so `startMic` and the page machine are unchanged; its audio pipe lives for the whole page, so a recogniser restart never stops the audio, and text that arrives while no recogniser is started is delivered to the next one. Nothing he says is dropped.
- **Daemon.** `src/asr.ts`: each `/asr` connection gets its own Silero voice detector (threshold 0.5, 0.25 s minimum speech, 0.5 s silence ends a segment, 20 s maximum). Every segment is decoded by the one shared Parakeet recogniser, one after another, so text arrives in the order he spoke. The socket answers `{"type":"speechstart"}` when speech begins and `{"type":"final","text":...}` per segment. A missing engine answers `{"type":"error"}` once, naming the install script, and the daemon logs `asr <message>`.
- **Turns.** A segment ends at half a second of silence, but the turn does not: the page's autosend hold (spec 005) still decides when his turn is over, so a pause only splits his words into segments that join into one turn.
- **Echo.** Echo cancellation on the stream removes the agent's voice; the page's text echo check (spec 005) still drops anything that matches what the agent just said.
- **Listens never clear words.** Opening a listen (an `stt`, or the end of a `tts` with `listen`) never clears words already heard: the mic stays on between listens, and clearing there sent 9 of 58 words (2026-10-07). Only a sent turn clears them. A listen that opens while the mic already runs turns the light green (`REQUEST` in the turn region); every way the mic stops clears its running flag, so the light never goes green with no recogniser behind it (it did after a speak-only `tts`, 2026-10-07).
- **Tests.** The e2e suite injects a fake recogniser as `globalThis.__sttsRecognition`; the page uses it in place of the daemon engine.

## What it reads and writes

Reads the microphone (through Chrome) and, in the data folder: `asr/node_modules/sherpa-onnx-node` (pinned 1.13.8), `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/` (about 630 MB) and `models/silero_vad.onnx`. The plugin ships without `node_modules` and a native addon cannot be bundled, so these are installed like Piper, by mkb-agentops `scripts/setup-stts.ps1`. Writes nothing; audio is never stored.

## How to run, check and hand over

`npm test` runs `test/unit/asr.test.ts`: a missing engine reports how to install it, and, where the engine is installed, the model's own test recording streamed in odd-sized chunks comes back word for word. To check by hand, run the built daemon on a spare port (`STTS_PORT=15990 STTS_LIVE_UPDATE=0 node dist/daemon.js`) and stream a 16 kHz recording into `ws://127.0.0.1:15990/asr` as float32 blocks; finals print within about a second of each pause. To change the model, change `MODEL` and the transducer file names in `src/asr.ts` and the download in `setup-stts.ps1`; sherpa-onnx runs Whisper, Moonshine and others with the same API.
