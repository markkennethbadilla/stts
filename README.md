# stts

stts is a voice window for coding agents: an MCP server (`stts-mcp`, tools `stt` and `tts`) talks to a small local daemon on `127.0.0.1:15986`, which drives a Chrome app window that listens with on-device speech recognition and speaks with Piper. It ships as the Claude Code plugin `stts` from the `stts-marketplace` and also runs over stdio behind an MCP gateway. Data lives in `%LOCALAPPDATA%\cc-gc-stts\`. MIT licence, see `LICENSE`.

## Install

1. `/plugin marketplace add markkennethbadilla/stts`
2. `/plugin install stts@stts-marketplace`
3. Run `/stts` to start a voice conversation.

No `npm install` or build happens on install: the bundled `dist/` (self-contained `dist/mcp.js` and `dist/daemon.js`, plus the page) is committed to the repository. After changing `src/`, `web/` or `public/`, run `npm run build` and commit `dist/` with the change; CI fails on a stale `dist/`.

Gateway (MCPJungle, every agent): register a stdio server with command `node <repo>/dist/mcp.js` (no build needed, `dist/` is committed) and env `STTS_WHO=agent`, so a helper agent cannot close the session's window. The entry lives in mkb-agentops (spec 010).

For development: `npm ci`, then `npm run check` and `npm run build`. `npm run e2e` builds, starts the daemon on `STTS_TEST_PORT` (default 15990) with its own data dir under `test-results/`, and drives the page in headless Chromium with a fake speech recogniser, fake media, `page.clock` and a fake Piper server. Locally it uses the shared Playwright headless shell from `mkb-agentops/versions.json`.

CI (`.github/workflows/ci.yml`): one job on ubuntu-latest, pull requests and pushes to main that touch code only, cancel-in-progress, 15-minute cap. A run takes about 3 minutes; at about 40 runs a month that is about 120 of the free 2,000 minutes.

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
