# Speech engine

## What it does

Turns what Mark says into text and speaks the agent's replies with Chrome's own speech, in the voice window page. No speech model is downloaded, installed or run on this computer: recognition is Chrome's built-in `SpeechRecognition` (`webkitSpeechRecognition`) and the voice is the browser's `speechSynthesis`. The daemon touches no audio.

## Why it exists

Mark chose no local models on 2026-11-25: "switch it back to chrome tts so it dont need a model", "scrub parakeet", "i override that put it back to chrome tts". This replaces the local engine that was built on 2026-10-07 (sherpa-onnx voice detection with NVIDIA Parakeet, and Piper for speech), which needed about 760 MB of models, a Python venv and a native addon on every machine.

The local engine was built because Chrome's recogniser lost words: sessions that started late cut off the start of a sentence, restarts threw away speech in flight, and a two-minute turn came back as one word. This spec keeps Chrome's engine and handles those faults in the page instead (see "Restarts").

## How it works

- **Recognition.** `web/chromeRecognition.ts` (`ChromeRecognition`) wraps Chrome's recogniser behind the shape the page machine already uses (`start`, `stop`, `abort`, `onstart`, `onend`, `onerror`, `onspeechstart`, `onspeechend`, `onaudiostart`, `onresult`; continuous, interim results, `en-US`). `startMic` in `web/App.tsx` opens one echo-cancelled, noise-suppressed mic stream (spec 006) and starts the recogniser on its track, so the agent's voice is removed before the recogniser hears it.
- **Restarts.** Chrome ends a session on its own (about every minute, on silence, on a network blip). The wrapper restarts at once, never telling the page the recogniser ended: the page sees one unbroken session. Words still forming when a session ends are turned into a final result and handed to the page before the restart, and results of earlier sessions stay in the list (their indexes do not move), so nothing heard is dropped. `no-speech`, `aborted` and `network` errors only end a session and restart it; any other error (`not-allowed`, `audio-capture`, a missing recogniser) goes to the page and ends the wrapper. A session that ended in under 0.5 s waits 0.3 s before the restart, so a dead service never spins. A restart that throws is reported as a `network` error. `abort` (the page's stop) ends it once with no restart; the page uses `abort`, not `stop`, because `stop` waits for a final the service may never send and Chrome runs one session at a time.
- **Live words.** Interim results are shown at once as shimmering words, restart the auto-send hold, confirm a barge and tell the daemon he is talking (`talking`, spec 002).
- **Speech.** `speak` in `web/App.tsx` says each clip (spec 004) with one `SpeechSynthesisUtterance` at a time; its end sends `CLIP_ENDED`, an error is logged (`voice error REASON`) and counts as ended so the speech never stalls. Rate is the slider or the call's `rate`, volume the call's `volume`. Word boundary events, where the voice sends them, give the word a barge cut in on; a voice with none (Chrome's online voices) leaves the barge at sentence level. Pause and resume (`speechSynthesis.pause` and `resume`) duck the voice while his words decide a barge; cut-off is `cancel`, then `resume` so Chrome's queue is never left paused.
- **Voice.** `pickVoice` uses the voice saved in settings if the browser has it, else the best English one: a Natural or Online neural voice (mkb-winops turns on NaturalVoiceSAPIAdapter online voices, no local model), then a Google voice, then the first English voice. The settings list shows the English voices the browser reports.
- **Echo.** The browser voice plays outside the page's audio, so echo cancellation cannot remove it. With barge-in on, use a headset; with it off the mic track is muted while the agent speaks (spec 006). The page's text echo check (spec 005) still drops anything that matches what the agent just said.
- **Listens never clear words.** Opening a listen never clears words already heard: the mic stays on between listens. Only a sent turn clears them.
- **Tests.** The e2e suite injects a fake recogniser as `globalThis.__sttsRecognition` and a fake `speechSynthesis` (`__tts`, `test/e2e/fixtures.ts`); `test/unit/chrome-recognition.test.ts` covers the restart and error rules.

## What it reads and writes

Reads the microphone through Chrome and uses Chrome's speech services (recognition goes to Google's service, so it needs a network). Writes nothing; audio is never stored; the daemon has no `/asr` or `/voice` route, no child process and no models folder.

## How to run, check and hand over

`npm test` runs the unit tests (including `chrome-recognition.test.ts`) and the e2e suite. By hand: open the window (`/stts`), speak, and watch interim words appear and a turn arrive; speak for over a minute and check no words are lost across Chrome's session restarts. An agent shell cannot speak aloud (never unprompted), so the voice is checked by the e2e fake and by reading the built page bundle. Machines that ran the old engine can delete their `piper` and `asr` folders under the data folder, `silero_vad.onnx` under `models`, and the shared `piper` and `parakeet` model folders; mkb-agentops `setup-stts.ps1` recycles what it installed.
