# stts

stts is a voice window for coding agents: an MCP server (`stts-mcp`, tools `stt` and `tts`) talks to a small local daemon on `127.0.0.1:15986`, which drives a Chrome app window that listens with on-device speech recognition and speaks with Piper. It ships as the Claude Code plugin `stts` from the `stts-marketplace` and also runs over stdio behind an MCP gateway. Data lives in `%LOCALAPPDATA%\cc-gc-stts\`.

## Install

1. `/plugin marketplace add markkennethbadilla/stts`
2. `/plugin install stts@stts-marketplace`
3. Run `/stts` to start a voice conversation.

For development: `npm ci`, then `npm run check` (biome, tsc, vitest) and `npm run build`.

## Licences

MIT, see `LICENSE`. The `@modelcontextprotocol/sdk` 1.32.1 `LICENSE` file in `node_modules` reads "MIT License, Copyright (c) 2024 Anthropic, PBC", so it is MIT despite GitHub's NOASSERTION label.

## Routes

The daemon listens on `127.0.0.1:${STTS_PORT:-15986}`:

- `GET /` the page, `GET /earcon/:name.ogg` the earcons
- `GET /api/ping` returns `ok` plus the `X-Stts-Dir` header; `POST /api/shutdown`
- `POST /request` returns plain text: 200 is the tool reply, any other status (409 unanswered turn, 504 superseded, 400 bad input) is the tool error text
- `GET /barge` returns `{text:"", open}`; `POST /notify` ends an open listen with the background result
- `POST /voice/clip` `{text, voice, rate}` returns Piper's `audio/wav`; the page speaks through it so it needs one origin
- WebSocket `/ws` carries the page messages defined in `src/protocol.ts`

`STTS_WHO=agent` (set by the MCP gateway entry) marks calls from helper agents, whose `close` is ignored. The plugin's `.mcp.json` sets nothing, which means `session`. `npm run build` writes `dist/mcp.js`, `dist/daemon.js`, `dist/web/` and `dist/earcon/`.
