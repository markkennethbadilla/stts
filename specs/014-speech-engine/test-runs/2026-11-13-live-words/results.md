# Test run 2026-11-13: live words, wordless sounds, one thought one turn

## Target

- Risk tier: Standard (a local voice tool, no money, auth or tenant data).
- System: stts daemon, speech engine and voice page; local, Windows 11, Node 26.13.
- Build: commit 4264316 (worktree `voice-critique`, since pushed to `main`).
- Engine: sherpa-onnx 1.13.8, Parakeet TDT 0.6B v2 int8, Silero VAD, installed in `%LOCALAPPDATA%\stts`.
- Date: 2026-11-13, Manila.
- In scope: the five complaints in the handoff (voice stops, no live words, cut turns, long turn spans, misheard words).
- Entry check: engine installed, build green, test daemon answers on its spare port.

## Totals

planned 245 = PASS 242 + FAIL 0 + BLOCKED 0 + NOT RUN 3

## Verdict

SHIP WITH KNOWN ISSUES: no FAIL; NOT RUN are L-03 (a real wordless sound through the real detector), L-05 (the 70 s gap of turn 6) and L-06 (misheard words), none on a path this change touches without another passing case.

## Cases

| id | type | covers | input | expected | actual | verdict | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S-UNIT | suite | regression, all specs | `vitest run`, every unit file but the engine one | all pass | 206 passed, 0 failed | PASS (206) | `vitest.json` |
| S-ASR | suite | spec 014 live words | `vitest run test/unit/asr.test.ts`: the model's own recording fed in near real time | more than one interim before the first final, the first starting "well"; every word in the finals | 2 passed, 0 failed | PASS (2) | `vitest-asr.json` |
| S-E2E-VOICE | suite | regression, page and daemon | `playwright test test/e2e/voice.spec.ts` | all pass | 11 passed | PASS (11) | `e2e-voice.txt` |
| S-E2E-REG | suite | regression; barge pause and resume | `playwright test test/e2e/zz-regressions.spec.ts` | all pass | 19 passed | PASS (19) | `e2e-regressions.txt` |
| L-01 | happy | complaint 2, live words | built daemon on port 15993, `0.wav` (7.4 s) streamed to `/asr` in 100 ms blocks | interim text within 1 s of speechstart, growing, then the final | speechstart at 868 ms, first interim "Well I don't wish to" at 1537 ms (669 ms later), 8 interims about every 0.5 s, final at 5623 ms; second utterance the same | PASS | `live-probe.json` |
| L-02 | happy | segment log | the live daemon after the update, Mark speaking | one `asr segment` line per segment with length and word count | `asr segment 9.4s decoded in 761ms, 22 words` at 00:37:41 UTC, then one turn of 22 words | PASS | `daemon.log` line 14536 |
| L-03 | curveball | complaint 1 on the real detector | 0.2 s noise burst streamed after the speech | `nowords` event | the detector did not trigger at all on the synthetic burst, so no event either way | NOT RUN | `live-probe.json`; the page path is covered by the e2e case "a sound with no words over the speech resumes it at once" and the unit case "live words" |
| L-04 | happy | live update | `POST /api/update`, then `/api/ping` | `X-Stts-Dir` names 42643162df2f | `...\stts\42643162df2f\dist`; log `live update: handing off` 00:37:23 UTC, page reloaded 00:37:27 | PASS | `daemon.log` lines 14526 to 14528 |
| L-05 | exploratory | complaint 4, turn 6 (70 s with nothing heard) | none: the audio of that minute was never stored | a cause | not reproducible from the log; the new segment lines will show it next time | NOT RUN | `daemon.log` 00:07:52 to 00:09:02 UTC has no line at all |
| L-06 | exploratory | complaint 5, misheard words | none | fewer misheard words | recogniser accuracy is unchanged by this commit | NOT RUN | - |
| C-01 | regression | callbot join wait 4 s | `node --test turn.test.mjs spec014.test.mjs segment.test.mjs pause-default.test.mjs` in weassist-callbot 4e76b7d | all pass | 8 passed, 0 failed | PASS (8) | callbot commit 4e76b7d; Coolify deployment p9a1g9vskelgm4o8li2dhm6j finished, `/health` ok |

Counts: 206 + 2 + 11 + 19 + L-01, L-02, L-04 (3) + C-01 as one case (1) = 242 PASS; L-03, L-05, L-06 = 3 NOT RUN.

## Failures and recommendations

None.

## Not covered

- A real cough or click through the real voice detector (L-03): needs a recording of one.
- The 70 s gap of turn 6 (L-05): no audio is ever stored, so it cannot be replayed.
- Recognition accuracy (L-06): out of scope of this commit; a model change is its own task.
- A full spoken conversation by a person in the window: Mark's own session ran on the new build from 00:37 UTC (L-02).

## Next

Retest owed: L-03 with a recorded cough, on the live window. L-05 waits on the next time it happens: read the `asr segment` lines for that minute.
