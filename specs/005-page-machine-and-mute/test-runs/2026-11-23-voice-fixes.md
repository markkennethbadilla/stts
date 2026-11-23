# Test run 2026-11-23: browser-voice fallback and tail loss

Ship verdict: SHIP. Totals: 8 cases, 8 PASS, 0 FAIL, 0 BLOCKED, 0 NOT RUN.

| # | Case | Command or source | Result | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Cause of the Windows voice and two voices at once found | `daemon.log` 2026-11-23T06:31:54Z: `page voice over speech, clip 2` then `page voice fallback play AbortError: The play() request was interrupted by a call to pause()` | a barge pause aborted `play()`, the page fell back to the browser voice, then the Piper clip resumed | PASS |
| 2 | Aborted `play()` never falls back | `vitest run test/unit/voice.test.ts` | `a play() aborted by a pause never falls back to the browser voice` passed | PASS |
| 3 | Cause of the lost tail found | `daemon.log` 06:30:59 `turn sent ... 7 words (the window showed up to 20)`, then `asr segment 8.7s ... 22 words`; 06:32:43 43 words sent, final 52 words | the final for the interim slot the turn was sent on was skipped as consumed | PASS |
| 4 | Late final tail reaches the next listen | `playwright test --grep "keeps the tail"` | `] tomorrow morning` returned | PASS |
| 5 | No regression in turn capture | `playwright test --grep "leading words\|pause mid-sentence\|30 s of continuous\|a listen produces\|typed message"` | 5 passed | PASS |
| 6 | Unit suite | `vitest run test/unit` | 213 passed | PASS |
| 7 | Push gate (biome, tsc, markdownlint, vitest, build, smoke e2e, dist diff, maintainability) | `git push` pre-push hooks | passed, main at e516e8c | PASS |
| 8 | Live daemon runs the fix | `curl -sI http://127.0.0.1:15986/api/ping` | `x-stts-dir ...\stts\e516e8c883cd\dist` | PASS |

Live proof on Mark's mic needs his voice: the next real barge logs `page voice play interrupted, no fallback` instead of `page voice fallback play AbortError`.
