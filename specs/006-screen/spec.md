# Screen

## What it does

The voice window Mark sees (`web/App.tsx`): a large coloured orb that shows whose turn it is, his words as he speaks, the agent's words as they are spoken, and a small row of controls. It listens with the browser's on-device speech recognition and plays the agent's voice.

## Why it exists

He talks hands-free and glances at the window. Colour and sound tell him the state at a glance; the only text is the transcript.

## How it works

- **Orb** (elevenlabs/ui) tinted by the turn: grey not listening, green speak now, amber heard, amber-brown background result, blue agent speaking. A ripple (magicui) shows while listening and a live waveform while speaking. A shrinking ring counts down the auto-send. Interim words shimmer (motion-primitives). A turn-number chip and one status icon (lucide). The header, the words, the wave strip and the keyboard box are stacked in one column, so they never overlap at any window size: the wave strip keeps its 96 px reserved, and words longer than the space scroll.
- **Controls:** Mute/Unmute, Stop (stops speech and reports `stopped{part}`), Settings, End conversation (sends `ended`). Stop and End only act on a real click (`isTrusted`). No spoken word operates the window.
- **Keys:** Ctrl+M or Ctrl+R mute and unmute; Alt+Up and Alt+Down browse history (50 each of his prompts and the agent's replies).
- **Keyboard mode:** a Keyboard / AudioLines toggle in the header (AudioLines, not Mic, so it never looks like the mute button) sets the primary input, saved in `__stts__input_mode`. In keyboard mode a shadcn Textarea sits at the bottom: Enter or the Send button sends, Shift+Enter is a new line, Alt+Up and Alt+Down fill it from his prompt history. Typing while the agent speaks cuts the speech off (barge-in, spec 005).
- **Settings popover:** voice, rate, auto-send, hold, mic picker, earcons and their volume, raise-on-request (off by default). Saved in `localStorage` under the old `__stts__*` keys so earlier settings carry over.
- **Listening:** Web Speech recognition with `processLocally`, started on an echo-cancelled mic track. The listen-open chime plays first, so it is never recorded.
- **Speaking:** text is cut into sentences (spec 004) and packed into clips of at most 120 characters, and each clip is fetched from `/voice/clip` (Piper, default voice `en_GB-jenny_dioco-medium`); the next 3 clips are fetched while one plays, so the first word waits for one short clip only and clips play with no gap. On load the page calls `/voice/warm` so Piper loads its model before the first reply. The settings popover lists the Piper voices from `/voice/list` first, then the Windows voices. A saved voice that is not an installed Piper voice (an old Windows pick) still speaks with the Piper default. Only when the clip request itself fails does the browser's own voice speak it, and the page logs `voice fallback REASON` first, so a fallback is never silent.
- **Earcons:** Kenney Interface Sounds (CC0) in `public/earcon/`: `listen-open`, `turn-captured`, `background-result`, one per state change.
- The 1600x600 strip and a 390 wide phone layout come from Tailwind container queries.

The status icon turns red when the mic has failed (spec 005: on-device and cloud recognition both refused the language).

## What it reads and writes

Reads the mic and the daemon's WebSocket messages. Writes `localStorage` settings and history, and sends page messages (spec 001) back to the daemon.

## How to run, check and hand over

`npm run dev` serves the page with Vite. `test/screenshots/shoot.ts` produces the screenshots in `test/screenshots/` at 1600x600 and 390 wide; check them for layout and for no console errors. `test/unit/page-log.test.ts` checks the page's log lines.

The window icon is a glowing blue orb (the agent-speaking colours from `web/App.tsx`) with the lucide `audio-waveform` glyph (ISC licence) on a full-bleed dark square. Source is `public/favicon.svg`; `favicon.ico`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` and `manifest.webmanifest` were generated from it once with the `favicons` npm package 7.3.1 (not a dependency). `index.html` links them, and the Chrome `--app` window takes its taskbar icon from them. To change the icon, edit the SVG and rerun `favicons` 7.3.1 on it.
