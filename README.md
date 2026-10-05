# stts

stts is a voice window for coding agents: an MCP server (`stts-mcp`, tools `stt` and `tts`) talks to a small local daemon on `127.0.0.1:15986`, which drives a Chrome app window that listens with on-device speech recognition and speaks with Piper. It ships as the Claude Code plugin `stts` from the `stts-marketplace` and also runs over stdio behind an MCP gateway. Data lives in `%LOCALAPPDATA%\cc-gc-stts\`.

## Install

1. `/plugin marketplace add markkennethbadilla/stts`
2. `/plugin install stts@stts-marketplace`
3. Run `/stts` to start a voice conversation.

For development: `npm ci`, then `npm run check` (biome, tsc, vitest) and `npm run build`.

## Licences

MIT, see `LICENSE`. The `@modelcontextprotocol/sdk` 1.32.1 `LICENSE` file in `node_modules` reads "MIT License, Copyright (c) 2024 Anthropic, PBC", so it is MIT despite GitHub's NOASSERTION label.
