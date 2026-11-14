# Test run 2026-11-14: speech engine on the one blessed Parakeet v3 copy

## Target

- Risk tier: Standard (a local voice tool, no money, auth or tenant data).
- System: stts daemon and speech engine; local, Windows 11, Node 26.13, Work account, data folder `%LOCALAPPDATA%\stts`.
- Build: commits 14d23e4 (engine on v3) and its follow-up (an empty final keeps the live words), both on `main`.
- Engine: Silero VAD from sherpa-onnx-node 1.13.8; Parakeet TDT 0.6B v3 int8 at `A:\models\parakeet\parakeet-tdt-0.6b-v3-int8`, read by onnx-asr 0.12.0 in a Python worker.
- Compared with: the engine before, sherpa-onnx with Parakeet v2 int8 from the per-account folder.
- Date: 2026-11-14, Manila.
- In scope: the engine reads only the shared copy; nothing heard is lost against v2; the per-account copy is gone; a spoken sentence transcribes through the `stt` tool.
- Entry check: blessed files present with the register's names, onnx-asr imports in the venv, build green.

## Totals

planned 224 = PASS 221 + FAIL 0 + BLOCKED 0 + NOT RUN 3

## Verdict

SHIP WITH KNOWN ISSUES: no FAIL. NOT RUN are C-08 (the fix for an empty final cannot be retested without the speech that caused it; audio is never stored), C-09 (speaker playback into the microphone: the window was ended first) and C-14 (worker down message, not exercised). Known issue: Parakeet v3 decodes some clips to nothing where v2 did not; three guards cover it (0.3 s trailing silence, one retry without the first 0.1 s, an empty final keeps the live words) and the log line `decode empty, live words kept` counts what is left.

## Cases

| id | type | covers | input | expected | actual | verdict | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S-UNIT | suite | regression, all specs; the engine on the blessed copy; a missing engine names the install script | push gate `vitest run` (16 files); `asr.test.ts` streams `test/fixtures/phoebe.wav` at the speed of speech through the real worker | all pass; live words before the first final; the finals are the recording word for word, ending "old portrait." | 208 passed, 0 failed | PASS (208) | push gate output of 14d23e4 |
| S-E2E | suite | regression, page and daemon | push gate `playwright test --grep @smoke` | all pass | 4 passed (23.6 s) | PASS (4) | push gate output of 14d23e4 |
| C-02 | happy | onnx-asr reads the blessed files | the whole 7.4 s recording decoded from `A:\models\parakeet\parakeet-tdt-0.6b-v3-int8` | the reference sentence | exact, load 4.7 s, decode 0.96 s cold and 0.62 s warm | PASS | this table |
| C-03 | comparison | nothing lost against v2, segments | 25 spoken sentences (12 Piper sentences in 4 voices, each clean and with a noise floor, plus the recording), cut by the engine's own voice detector into 26 segments, decoded the way the worker does | no empty segment; word errors no worse than v2 | v3 2 errors in 259 words, v2 4 in 259; 0 empty of 25 sentences for both | PASS | `finals-v3.json` |
| C-04 | comparison | live partial clips | the same sentences cut into 98 partial clips the way live words are cut | no clip left empty | v3 raw 2 empty of 98 (v2 0); both come back with the retry without the first 0.1 s | PASS | this table |
| C-05 | regression | words that were not said | second segment of the recording, 2.4 s | "It is certainly very like the old portrait." | without trailing silence "...old portrait, it's not the same."; with 0.3 s of silence the expected text; retested on the same clip | PASS | `finals-v3.json` row `u99-real` |
| C-06 | happy | the live daemon | 13 of the sentences streamed as 100 ms float32 blocks into `ws://127.0.0.1:15986/asr` of the running daemon | every sentence back, live words on the longer ones | 1 word error in 141 ("15th" for "fifteenth"), 0 empty, segments decoded in 0.3 to 0.5 s | PASS | `live-socket.json`; `daemon.log` 08:48 UTC |
| C-07 | happy | a spoken sentence through the `stt` tool | one `stt` call (start, 50 s); Mark spoke to the window for 22 s | his words come back as a turn | turn 1, 3 segments of 8, 7 and 20 words, decoded in 0.6 to 1.0 s each, returned as one turn | PASS | `daemon.log` 08:50:17 to 08:50:28 UTC |
| C-08 | curveball | an empty final after live words | the same session: a 2.9 s segment after the turn | its words in the final | at 14d23e4 the final decoded to 0 words after 2 live words had been shown; the page kept the live words, so the turn was whole. Fixed in the follow-up commit (the daemon sends the live words as the final) | NOT RUN (fix not retested: the speech is not stored) | `daemon.log` 08:50:35 UTC |
| C-09 | happy | speaker to microphone | a Piper sentence played through the speakers during the listen | the sentence comes back | the window was ended at 08:50:41 UTC, before the first playback at 08:50:47 | NOT RUN | `daemon.log` |
| C-10 | happy | install and cleanup, Work account | `setup-stts.ps1 -Apply` from agentops `main` | 5 engine steps OK, no model download, the v2 folder recycled | 5 of 5 OK; `models\` holds only `silero_vad.onnx` (636 KB, was 632 MB) | PASS | `setup-apply.txt` |
| C-11 | happy | Personal account on this laptop | onnx-asr installed in its venv, its v2 folder recycled, both read back | `onnx-asr==0.12.0`; `models\` holds only `silero_vad.onnx` | as expected | PASS | this table |
| C-12 | regression | no stray stts model | mkb-winops host test "no model files outside A:\models" with the stts pending entry removed | no stts path in the list | none; the one path listed is Meetily's copy on the Personal account, not stts | PASS | host test output |
| C-14 | sad | worker down | a venv without onnx-asr | the page gets an error naming the failure and the install script | not exercised | NOT RUN | none |

## Recommendations

- C-08: watch `daemon.log` for `decode empty, live words kept`; if it shows up often in real use, add a second retry form in `asr_worker.py` before looking at the model.
- C-14: exercise once on a machine before its setup has run.
