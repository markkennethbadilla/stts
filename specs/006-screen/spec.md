# Screen

## What it does

The voice window Mark sees (`web/App.tsx`): a large coloured orb that shows whose turn it is, his words as he speaks, the agent's words as they are spoken, and a small row of controls. It listens with the browser's on-device speech recognition and plays the agent's voice.

## Why it exists

He talks hands-free and glances at the window. Colour and sound tell him the state at a glance; the only text is the transcript.

## How it works

- **Orb** (elevenlabs/ui) tinted by the turn: grey not listening, green speak now, amber heard, amber-brown background result, blue agent speaking. A ripple (magicui) shows while listening and a live waveform while speaking. A shrinking ring counts down the auto-send. Interim words shimmer (motion-primitives). A turn-number chip and one status icon (lucide).
- **Controls:** Mute/Unmute, Stop (stops speech and reports `stopped{part}`), Settings, End conversation (sends `ended`). Stop and End only act on a real click (`isTrusted`). No spoken word operates the window.
- **Keys:** Ctrl+M or Ctrl+R mute and unmute; Alt+Up and Alt+Down browse history (50 each of his prompts and the agent's replies).
- **Settings popover:** voice, rate, auto-send, hold, mic picker, earcons and their volume, raise-on-request (off by default). Saved in `localStorage` under the old `__stts__*` keys so earlier settings carry over.
- **Listening:** Web Speech recognition with `processLocally`, started on an echo-cancelled mic track. The listen-open chime plays first, so it is never recorded.
- **Speaking:** text is cut into sentences (spec 004) and each clip is fetched from `/voice/clip` (Piper, default voice `en_GB-jenny_dioco-medium`). If a clip fails, the browser's own voice speaks it.
- **Earcons:** Kenney Interface Sounds (CC0) in `public/earcon/`: `listen-open`, `turn-captured`, `background-result`, one per state change.
- The 1600x600 strip and a 390 wide phone layout come from Tailwind container queries.

The status icon turns red when the mic has failed (spec 005: on-device and cloud recognition both refused the language).

## What it reads and writes

Reads the mic and the daemon's WebSocket messages. Writes `localStorage` settings and history, and sends page messages (spec 001) back to the daemon.

## How to run, check and hand over

`npm run dev` serves the page with Vite. `test/screenshots/shoot.ts` produces the screenshots in `test/screenshots/` at 1600x600 and 390 wide; check them for layout and for no console errors. `test/unit/page-log.test.ts` checks the page's log lines.

The window icon is a glowing blue orb (the agent-speaking colours from `web/App.tsx`) with the lucide `audio-waveform` glyph (ISC licence) on a full-bleed dark square. Source is `public/favicon.svg`; `favicon.ico`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` and `manifest.webmanifest` were generated from it once with the `favicons` npm package 7.3.1 (not a dependency). `index.html` links them, and the Chrome `--app` window takes its taskbar icon from them. To change the icon, edit the SVG and rerun `favicons` 7.3.1 on it.
