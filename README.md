# stts

stts is a voice window for coding agents: an MCP server (`stts-mcp`, tools `stt` and `tts`) talks to a small local daemon on `127.0.0.1:15986`, which drives a Chrome app window that listens with Chrome's built-in speech recognition and speaks with a local Piper voice when it is installed (`node scripts/install.mjs`), else with the browser's voice (`speechSynthesis`). Nothing is downloaded unless you run that script. It ships as the Claude Code plugin `stts` from the `stts-marketplace` and also runs over stdio behind an MCP gateway. Data lives in `%LOCALAPPDATA%\stts\`. MIT licence, see `LICENSE`.

## Install

1. `/plugin marketplace add markkennethbadilla/stts`
2. `/plugin install stts@stts-marketplace`
3. Run `/stts` to start a voice conversation.

Needs Node 20+ and Chrome. Speech recognition is Chrome's own (it uses Google's service, so it needs a network); the voice is Piper after `node scripts/install.mjs` (a Python venv and one pinned voice under `%LOCALAPPDATA%\stts`), otherwise the best English voice the browser offers, changeable in settings.

No `npm install` or build happens on install: the bundled `dist/` (self-contained `dist/mcp.js` and `dist/daemon.js`, plus the page) is committed to the repository. After changing `src/`, `web/` or `public/`, run `npm run build` and commit `dist/` with the change; the push gate fails on a stale `dist/`.

Gateway (MCPJungle, every agent): register a stdio server with command `node <repo>/dist/mcp.js` (no build needed, `dist/` is committed) and env `STTS_WHO=agent`, so a helper agent cannot close the session's window. Our own machines register it from mkb-agentops (spec 010).

For development: `npm ci`, then `npm run check` and `npm run build`. `npm run e2e` builds, starts the daemon on `STTS_TEST_PORT` (default 15990) with its own data dir under `test-results/`, and drives the page in headless Chromium with a fake speech recogniser, a fake browser voice, fake media and `page.clock`. Locally it uses the shared Playwright headless shell from `mkb-agentops/versions.json`.

Checks: a local Trunk push gate (`npm run gate`, spec 011), no GitHub Actions. Run `trunk git-hooks sync` once per clone.

## Design decisions

Each choice, the option rejected and why. A new one is added here in the change that makes it.

- Listening uses Chrome's built-in `SpeechRecognition`. Rejected: a local recogniser (sherpa-onnx voice detection, then Parakeet through onnx-asr), removed because no local speech model is wanted for listening; the page restarts Chrome's sessions itself so no words are lost (spec 014).
- Speaking uses local Piper when installed, the browser voice otherwise. Rejected: the Microsoft Online voice as the default (network lag before each clip). Piper starts with the daemon, so the first clip is warm (spec 014).
- One daemon holds one request at a time with a 240 s budget. Rejected: a window per call and long blocking calls, which MCP gateways drop near 300 s (spec 003).
- `dist/` is committed and the commit is the version. Rejected: building on install, which fails for a user without the build tools; the gate fails a stale `dist/` (spec 009).
- Tools speak MCP over stdio, the same `dist/mcp.js` behind a gateway. Rejected: an HTTP-only server, which not every agent CLI can call (specs 008, 010).
- A new version hands over from the running daemon between turns. Rejected: asking for a restart, which loses the conversation (spec 013).
- Checks run in a local Trunk push gate. Rejected: hosted CI, which sat red on main for six commits because nobody ran it before pushing (spec 011).

## Changes that remove or rename something

- A removed or renamed tool, argument, sentinel or setting is listed under this heading in the same commit, with what replaces it; installs update on their own, so this is where users find out.
- Wording an agent reads lives in `src/protocol.ts`; a change updates `test/fixtures/old-contract.json` on purpose and the callbot in the same session (spec 001).
- A renamed setting or moved data folder is migrated in place on the first start of the new version, so a user's settings and profile survive (spec 009, public repo rule 6).
- Nothing listed yet.

## Specs

- [001 Protocol and sentinels](specs/001-protocol-and-sentinels/spec.md)
- [002 Turns](specs/002-turns/spec.md)
- [003 Daemon slot and budget](specs/003-daemon-slot-and-budget/spec.md)
- [004 File read-aloud in parts](specs/004-read-aloud/spec.md)
- [005 Page machine and mute](specs/005-page-machine-and-mute/spec.md)
- [006 Screen](specs/006-screen/spec.md)
- [007 Plugin shell and hooks](specs/007-plugin-shell-and-hooks/spec.md)
- [008 MCP server and client](specs/008-mcp-server-and-client/spec.md)
- [009 Install and upgrade](specs/009-install-and-upgrade/spec.md)
- [010 Gateway and callbot sharing](specs/010-gateway-and-callbot-sharing/spec.md)
- [011 Tests and CI](specs/011-tests-and-ci/spec.md)
- [012 Logging](specs/012-logging/spec.md)
