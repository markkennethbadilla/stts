# Logging

## What it does

Writes one line per notable event to `daemon.log` in the data folder, from both the daemon and the page, so a problem can be traced afterwards.

## Why it exists

Voice problems are hard to reproduce. A plain log that tools and people can search shows what happened and when, without recording what Mark said.

## How it works

Each line is an ISO timestamp then the event. Lines from the page start with the word `page`. These lines are searched for and kept word for word:

| Line | From |
| --- | --- |
| `daemon start pid N` | daemon started |
| `daemon exit pid N code C` | daemon stopped |
| `ws bad message` | a WebSocket frame failed the check |
| `chrome launch failed ...` | the window could not open |
| `window gone mid-call: reopening the window in MSms` | the page disconnected while a call was open; the window reopens after MS (spec 003, self-heal) |
| `window did not open: reopening the window in MSms` | a launch failed or no page connected in 15 s while a call was open; it is tried again after MS |
| `page mic switched to default` / `page mic switched to a new device` | the mic picked changed (or fell back to the default after an unplug) while the mic was open; the recogniser restarts on it |
| `page mic device gone` | the open mic stream's device was unplugged; the mic restarts on the chosen device or the default |
| `page voice error REASON` | the browser voice failed a clip; the clip counts as ended |
| `live update: handing off to DIR` | the daemon is moving to a newer install (spec 013) |
| `page live update: reloading for the new version` | the window reloads onto the new code |
| `page mic start` | mic opened |
| `page mic start timed out at STAGE` | a recogniser start reported nothing within 5 s and was restarted; STAGE is where it waited (cue, on-device check, getUserMedia, recogniser start) |
| `window closed` | the Chrome window closed; the daemon stays up |
| `page heard held for the next listen` | speech with no listen open, kept for the next one |
| `page skipped by Mark` | Skip or Esc stopped the speech |
| `page mic restart #N: reason` | watchdog, error or recogniser-ended restart |
| `page turn sent MSms after the last words, N words (the window showed up to M)` | auto-send fired: the end-of-speech delay, and word counts only (never the words): N below M means the recogniser revised its own text or words were dropped |
| `page light TURN` | the status light changed (notListening, speakNow, working, heard, background, agentSpeaking) |
| `page mic error ERROR` | speech recognition error |
| `page paused by Mark`, `page resumed by Mark` | mute and unmute |
| `page ws closed` | the page lost the daemon |

What he says is never logged. Clip lines carry only the first 30 characters of the agent's speech.

```mermaid
flowchart LR
  P[page] -->|log message over /ws| D[daemon]
  D --> L[daemon.log]
```

## Quality bar

Register B19 (ISO/IEC 25010:2023). Baselines measured 2026-11-26 unless dated.

| Aspect | Metric, baseline and floor | Research and alternative | Gate |
| --- | --- | --- | --- |
| Functional suitability | One line per notable event from daemon and page in `daemon.log`: `page-log.test.ts` 1/1; floor 0 failing | structured one-line events; alternative: console only (lost on close) | vitest in `npm run gate` (Trunk pre-push) |
| Performance efficiency and optimisation | Append-only line writes, no flush wait on the request path | async append | n/a: not timed separately |
| Compatibility | Plain text lines any tail or search reads | plain text logs | n/a: no reader to break |
| Interaction capability | Each line names the stage (`page mic start timed out at STAGE`) | actionable log messages | spec table of log lines |
| Reliability | Failures log the real error text (house rule 43a) | log every outcome | `page-log.test.ts` |
| Security | 0 secrets in repo; the daemon and Piper bind 127.0.0.1 only, nothing listens off the machine; floor 0 gitleaks findings | OWASP ASVS V14 config; alternative: LAN-reachable daemon (rejected: no auth needed when local only) | gitleaks in Trunk (`trunk check` in the gate) |
| Maintainability | `npm run maint` 2026-11-26: 0 dependency violations (53 modules), 0 jscpd clones, knip clean; spec has the five sections; floor all three clean | dependency-cruiser, knip, jscpd; markdownlint MD043 for sections | `npm run maint`, `markdownlint-cli2` in `npm run gate` (Trunk pre-push) |
| Flexibility and portability | n/a: one log file per data folder | n/a | n/a |
| Safety | No audio and no secrets in the log; words heard are Mark's own text on his PC | data minimisation | code review |
| Business outcome | n/a: Mark's personal voice tool, no business metric | n/a | n/a |
| Cost | USD 0: Chrome speech recognition and local Piper, no paid API; floor no paid call added | free platform APIs first (rule 1) | n/a: no paid dependency to cap (rule 97) |

## What it reads and writes

Appends to `%LOCALAPPDATA%\stts\daemon.log` (on Linux `~/.local/share/stts/daemon.log`). There is no rotation.

## How to run, check and hand over

Read the tail of `daemon.log` after a run. `test/unit/page-log.test.ts` checks the page lines.
