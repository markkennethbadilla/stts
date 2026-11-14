# Coverage

Against the coverage register in the mkb-agentops repo, skill `cover-the-whole-lifecycle` (rule 114, spec 134). This repo is a local voice-window plugin: a daemon on 127.0.0.1, one Chrome app window page, Piper TTS and a local speech engine. It has no hosted deploy, no database, no accounts and no analytics. Lines marked `gap:` are real holes, not decided as n/a.

## Build

- [x] B01 `specs/001-protocol-and-sentinels/` to `specs/014-speech-engine/` (one numbered spec per feature)
- [x] B02 `specs/011-tests-and-ci/spec.md` and every `specs/*/spec.md`, five sections enforced by markdownlint rule MD043
- [x] B03 public on purpose: Claude Code installs the plugin from this repo (`.claude-plugin/marketplace.json`); no `.github/` folder, so no Actions; no secrets in it
- [x] B04 `package.json` uses maintained packages (hono, MCP SDK, xstate, base-ui, three); the speech engine is `specs/014-speech-engine/spec.md`
- [x] B05 `package-lock.json` and `renovate.json` (`rangeStrategy: pin`)
- [x] B06 n/a: the repo holds and reads no secrets; gitleaks in `.trunk/trunk.yaml` guards commits
- [x] B07 n/a: no background dev stack; `npm run dev` is a one-off vite run and the tests start their own daemon on a spare port
- [x] B08 `test/screenshots/shoot.ts` and the committed `test/screenshots/` images (dark by default, `light-462x689-*`)
- [x] B09 this file
- [x] B10 `test/e2e/` drives the page through roles and test ids with a fake recogniser, fake media and `page.clock` (spec 011)
- [x] B11 n/a: not created from the site starter; a local plugin, not a site or app
- [x] B12 gap: no knip step in `npm run gate`

## Test

- [x] T01 `.trunk/trunk.yaml`: `gitleaks@8.30.1`, `block-commit-on-findings`, `block-push-on-findings`
- [x] T02 gap: `trunk check --ci --all` runs in the gate but osv-scanner is not in `lint.enabled`
- [x] T03 `.trunk/trunk.yaml`: `block-push-on-opengrep`
- [x] T04 `npm run gate`: `biome ci .` and `tsc --noEmit` (strictest config)
- [x] T05 `vitest run` in `npm run gate`, `test/unit/`
- [x] T06 the page is one screen; `npm run e2e:smoke` loads it in the gate (spec 011)
- [x] T07 gap: seven sizes are shot by `test/screenshots/shoot.ts` but there is no text-scale spec
- [x] T08 n/a: no database
- [x] T09 `specs/014-speech-engine/test-runs/2026-11-13-live-words/results.md`
- [x] T10 n/a: the window is always a Chrome app window (spec 006), Chromium only by design
- [x] T11 n/a: no AI feature of its own; it carries speech for the agent
- [x] T12 n/a: no AI feature of its own
- [x] T13 n/a: no AI feature of its own
- [x] T14 gap: no axe run on the page
- [x] T15 gap: `test/screenshots/` are committed images from `shoot.ts` but no spec compares against them
- [x] T16 n/a: one local page, no links to check
- [x] T17 n/a: no form
- [x] T18 n/a: no analytics
- [x] T19 n/a: no public API; the daemon protocol is tested by `test/unit/protocol.test.ts` and `test/fixtures/old-contract.json` (spec 001)
- [x] T20 n/a: no roles or tenants
- [x] T21 n/a: not a deployed web app; it listens on 127.0.0.1 only

## Integrate

- [x] I01 n/a: inbound data is only the owner's own mic audio on 127.0.0.1; `specs/012-logging/spec.md` deliberately never records what was said
- [x] I02 n/a: no payment, ads or CRM vendor
- [x] I03 n/a: no site, no analytics
- [x] I04 n/a: sends no email
- [x] I05 n/a: no paid API; Piper and the speech engine run locally from the blessed models folder (spec 009)
- [x] I06 n/a: no public form or AI endpoint

## Deploy

- [x] D01 n/a: not deployed; a new version reaches the open window by `specs/013-live-update/spec.md`
- [x] D02 n/a: no host build; the gate rebuilds and diffs the committed `dist/`
- [x] D03 n/a: no live host; `specs/009-install-and-upgrade/spec.md` covers install and upgrade
- [x] D04 n/a: no hosted web app; open windows update by `specs/013-live-update/spec.md`
- [x] D05 n/a: no live users; live update waits between turns (spec 013)
- [x] D06 n/a: no internal app; 127.0.0.1 only
- [x] D07 n/a: no deployed service; a bad version is reverted in git and the live update applies it

## Run

- [x] R01 n/a: not a website
- [x] R02 n/a: not deployed
- [x] R03 n/a: no scheduled job
- [x] R04 n/a: no Coolify service
- [x] R05 n/a: not deployed
- [x] R06 n/a: not a WeAssist server or site
- [x] R07 n/a: no daily check
- [x] R08 n/a: not a server
- [x] R09 n/a: not a server
- [x] R10 `specs/012-logging/spec.md`: `daemon.log` gets a line per notable event from the daemon and the page
- [x] R11 n/a: touches no production system
- [x] R12 n/a: no users beyond the owner; page errors reach `daemon.log` (spec 012)
- [x] R13 n/a: no AI feature of its own
- [x] R14 n/a: not deployed

## Break

- [x] X01 n/a: not deployed
- [x] X02 `test/e2e/zz-regressions.spec.ts` and `test/unit/echo-regression.test.ts`, one case per past defect

## Recover

- [x] V01 n/a: no database
- [x] V02 n/a: no database
- [x] V03 rule 5 and hook `guard-irreversible`; nothing stateful here to back up
- [x] V04 n/a: not a server
