# Tests and CI

## What it does

Lists the checks that must pass before a change lands, and how to run them.

## Why it exists

Two bugs on 2026-10-05 (an undefined name that crashed the page, and mute being undone by a restart) reached Mark because nothing checked them. Each now has a test.

## How it works

```mermaid
flowchart LR
  A[npm ci] --> B[biome ci .]
  B --> C[tsc --noEmit]
  C --> D[markdownlint-cli2 over specs]
  D --> E[vitest run]
  E --> F[playwright test]
```

- **Style and types:** Biome for lint and format; TypeScript with `@tsconfig/strictest`, no `any` and no suppressions.
- **Specs:** markdownlint-cli2 with `.markdownlint-cli2.jsonc`; rule MD043 makes every `specs/*/spec.md` have exactly the five sections in order.
- **Unit tests (vitest, `test/unit/`):** protocol and fixtures, turns, sentences, daemon through `app.request()`, client, MCP, hook, page machine, page log lines, build output, and the client-to-daemon integration.
- **Live check:** build, start the MCP server on a spare `STTS_PORT` with the SDK stdio client, call tts and stt, read `daemon.log`, then shut down.

- **End-to-end (Playwright, `test/e2e/`, `playwright.config.ts`):** builds, starts the daemon on `STTS_TEST_PORT` (default 15990) with its own data dir under `test-results/` and `STTS_NO_WINDOW=1` (it never launches a real window: one reopened by the self-heal took the page link from the test pages), and drives the page in headless Chromium with a fake speech recogniser, fake media, `page.clock` and a fake Piper server. Page errors fail the run. Cases (`test/e2e/voice.spec.ts`, then `zz-regressions.spec.ts`, which runs last): the narrow-width Send button under the box, Dark Reader lock and theme, no chime on an automatic restart, a fragment of the spoken sentence treated as echo, a new tts mid-speech cutting the old one off, his voice pausing the speech at once and an echo final resuming it, End reaches the open listen once, leading words across a growing session, a listen produces a turn, pause survives 3 listens and the watchdog, an untrusted End click is ignored, `/notify` produces a background result, a file is read in parts and resumed.
- **Push gate (Trunk, `.trunk/trunk.yaml`), no GitHub Actions (removed 2026-10-23 on Mark's order):** `trunk git-hooks sync` installs the hooks. The commit hook runs gitleaks and git-diff-check on staged files. The push hook runs `npm run gate`: `trunk check --ci --all`, then `npm run check` (biome, tsc, spec lint, vitest, build, Playwright), then `git diff --exit-code -- dist`. Both are custom actions with `--ci`, because Trunk's stock hook actions only warn when no terminal is attached. A failure refuses the push.

## What it reads and writes

Tests use their own ports and fakes; they do not touch the live daemon on 15986.

## How to run, check and hand over

`npm run check` runs biome, tsc, the spec lint and the unit tests; `npm test` runs the spec lint, the unit tests, the build and the Playwright tests, and is the check before every push: the old CI ran the browser suite but sat red on main for six commits (2026-10-06 to 07) because nobody ran it before pushing. `npm run e2e` runs the Playwright tests alone.

**Gate time budget.** Cold run on Mark's PC 2026-10-23: about 5.5 minutes, of which Playwright is about 3.5. Budgets only go down. Node takes about 1.5 s to start on this PC, so `vitest.config.ts` sets `testTimeout: 30_000` for the spawn-heavy hook tests.
