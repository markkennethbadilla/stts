# Hearing and one-word interrupt, live with Mark (2026-11-16)

Commits 4aaf767 (VAD 0.8 s silence, 0.5 s pre-roll, 0.1 s min speech), 76a11e6..16f01a9 (1 to 3 word turns hold 1.5 s), 3bb4e57 (gateway voice loop takes the barge; stop words always barge). Unit suite 211/211 PASS. Mic: SteelSeries Sonar Microphone on speakers, Mic Boost 0 dB (winops cd42ce7). Evidence: `%LOCALAPPDATA%\stts\daemon.log` 09:34 to 09:58 UTC.

| Case | Input | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
| H-01 | "option two, network" said while the agent was silent | whole phrase, one turn | "Option two network." (09:43:24) | PASS |
| H-02 | same phrase said over the agent's voice | whole phrase | "Option two next to work" (09:43:02): his voice mixed with speaker echo | FAIL (speaker echo, see limit) |
| H-03 | short answer with a pause before the last word | one turn | before 16f01a9 "option two" went alone; after, 1 to 3 words hold 1.5 s (unit test) | PASS |
| I-01 | one word over a gateway `stts_tts` listen | speech stops, word is the turn | before 3bb4e57 every barge logged `page barge held`; after, barge at 09:58:24 cut speech at sentence 3 word 7 | PASS |
| I-02 | "Stop." while the agent's own text contains "stop" | barge | before, discarded as echo (09:45:47); after, `bargeVerdict` returns barge (unit test) | PASS |
| I-03 | barge latency on speakers | within about 1 s | 3 to 6 s: speaker echo keeps the voice detector's segment open, so the word decodes only when it ends | FAIL (speaker echo, see limit) |

Totals: 6 cases, 4 PASS, 2 FAIL, 0 BLOCKED, 0 NOT RUN.

Limit: H-02 and I-03 come from speaker echo reaching the mic through the Sonar virtual device. Fix is a headset (the page's barge-in mode is built for it); code tuning cannot separate his voice from a loud echo cheaply.

Verdict: SHIP WITH KNOWN ISSUES.
