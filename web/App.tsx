// The orb screen (brief section 6): a full-bleed orb tinted by the turn state, wired to
// web/machine.ts. The machine decides; this file only supplies its side effects.
import { useMachine } from '@xstate/react';
import {
  AudioLines,
  Bell,
  CircleAlert,
  CircleStop,
  Ear,
  Keyboard,
  Mic,
  MicOff,
  PhoneOff,
  SendHorizontal,
  Settings2,
  Volume2,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { DaemonMessage, type PageMessage, parseMessage } from '../src/protocol.ts';
import { toParts } from '../src/sentences.ts';
import { Button } from './components/ui/button.tsx';
import { LiveWaveform } from './components/ui/live-waveform.tsx';
import { type AgentState, Orb } from './components/ui/orb.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx';
import { Progress } from './components/ui/progress.tsx';
import { Ripple } from './components/ui/ripple.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx';
import { Slider } from './components/ui/slider.tsx';
import { Switch } from './components/ui/switch.tsx';
import { TextShimmer } from './components/ui/text-shimmer.tsx';
import { Textarea } from './components/ui/textarea.tsx';
import { bargeVerdict, holdMs, isEcho, LANG_ERR, pageMachine } from './machine.ts';

type Turn = 'notListening' | 'speakNow' | 'heard' | 'background' | 'agentSpeaking';

const TINT: Record<Turn, [string, string]> = {
  notListening: ['#9ca3af', '#4b5563'],
  speakNow: ['#4ade80', '#15803d'],
  heard: ['#fbbf24', '#b45309'],
  background: ['#f59e0b', '#7c2d12'],
  agentSpeaking: ['#60a5fa', '#1d4ed8'],
};
const ORB_STATE: Record<Turn, AgentState> = {
  notListening: null,
  speakNow: 'listening',
  heard: 'thinking',
  background: 'thinking',
  agentSpeaking: 'talking',
};
const EARCON: Partial<Record<Turn, string>> = {
  speakNow: 'listen-open',
  heard: 'turn-captured',
  background: 'background-result',
};
const DEFAULT_PIPER = 'en_GB-jenny_dioco-medium';
const CLIP_CHARS = 120;
const HISTORY_MAX = 50;

// localStorage under the old __stts__* keys, so saved settings carry over.
const ls = {
  get: (k: string, d: string): string => localStorage.getItem(`__stts__${k}`) ?? d,
  set: (k: string, v: string): void => localStorage.setItem(`__stts__${k}`, v),
  list: (k: string): string[] => JSON.parse(localStorage.getItem(`__stts__${k}`) ?? '[]') as string[],
  push: (k: string, v: string): void =>
    localStorage.setItem(`__stts__${k}`, JSON.stringify([...ls.list(k), v].slice(-HISTORY_MAX))),
};

function useSetting(key: string, initial: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => ls.get(key, initial));
  return [
    v,
    (n) => {
      ls.set(key, n);
      setV(n);
    },
  ];
}

const LOCAL_EN = { langs: ['en-US'], processLocally: true };

type RecognitionStatics = {
  available?: (o: typeof LOCAL_EN) => Promise<string>;
  install?: (o: { langs: string[] }) => Promise<boolean>;
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  start: (track?: MediaStreamTrack) => void;
  stop: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
};

export function App() {
  const ws = useRef<WebSocket | null>(null);
  const rec = useRef<Recognition | null>(null);
  // On-device recognition: null until SpeechRecognition.available() has answered once.
  const local = useRef<boolean | null>(null);
  const heard = useRef({ final: '', startAt: 0 });
  // The clip whose echo was last logged: "page echo discarded" once per clip.
  const echoLogged = useRef('');
  // Every sentence started, with its start time: the echo guard compares against the last 10 s.
  const spokenLog = useRef<{ text: string; at: number }[]>([]);
  const recentSpoken = (): string[] => {
    const now = Date.now();
    spokenLog.current = spokenLog.current.filter((x) => now - x.at < 10000);
    return spokenLog.current.map((x) => x.text);
  };
  const listen = useRef({ part: 1, after: false, idleTimer: 0, idleSec: 200 });
  // Every listen opens here. Words left from before it (heard with no listen open, or the
  // agent's own tail) are dropped: a stale final made the idle timer skip nospeech and the
  // listen hang until the daemon budget, and a stale startAt dated turns minutes early.
  const armIdle = (sec: number, keepWords = false): void => {
    if (!keepWords) heard.current = { final: '', startAt: 0 };
    if (sec > 0) {
      listen.current.idleTimer = window.setTimeout(() => {
        if (!heard.current.final) post({ type: 'nospeech' });
      }, sec * 1000);
    }
  };
  const audio = useRef<HTMLAudioElement | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  // ponytail: entries for clips skipped by a Stop stay until a reload; a few KB of promises.
  const clipCache = useRef(new Map<string, Promise<Blob | string>>());
  const [interim, setInterim] = useState('');
  const [said, setSaid] = useState('');
  const [turnNo, setTurnNo] = useState(0);
  const [spoken, setSpoken] = useState({ done: 0, of: 0 });
  const [browse, setBrowse] = useState<{ side: 'prompts' | 'responses'; i: number } | null>(null);
  const [voice, setVoice] = useSetting('voice', DEFAULT_PIPER);
  const [rate, setRate] = useSetting('rate', '1');
  const [autosend, setAutosend] = useSetting('autosend', '1');
  const [hold, setHold] = useSetting('hold_ms', '');
  const [mic, setMic] = useSetting('mic', 'default');
  const [earcons, setEarcons] = useSetting('earcons', '1');
  const [earconVol, setEarconVol] = useSetting('earcon_vol', '0.5');
  const [raise, setRaise] = useSetting('raise', '0');
  const [inputMode, setInputMode] = useSetting('input_mode', 'mic');
  const [theme, setTheme] = useSetting('theme', 'system');
  useEffect(() => {
    const os = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && os.matches));
    apply();
    os.addEventListener('change', apply);
    return () => os.removeEventListener('change', apply);
  }, [theme]);
  const [draft, setDraft] = useState('');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [localVoices, setLocalVoices] = useState<string[]>([]);
  const [piperVoices, setPiperVoices] = useState<string[]>([DEFAULT_PIPER]);
  // A saved voice that is not an installed Piper voice (an old Windows pick) still speaks with Piper.
  const clipVoice = piperVoices.includes(voice) ? voice : DEFAULT_PIPER;

  const post = (m: PageMessage): void => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };
  const log = (line: string): void => post({ type: 'log', line });

  const [state, send, actor] = useMachine(
    pageMachine.provide({
      actions: {
        startMic: () => void startMic(),
        // A mic restart must not cancel the listen's idle timer, so stopMic leaves it alone.
        // The capture stream stops with it: every start opened a new one and none was ever closed.
        stopMic: () => {
          rec.current?.stop();
          // Its late end, error and speechend now belong to no one: a stopped recogniser moves nothing.
          rec.current = null;
          for (const t of micStream.current?.getTracks() ?? []) t.stop();
          micStream.current = null;
        },
        sendTurn: ({ context }, { text }) => {
          clearTimeout(listen.current.idleTimer);
          // The end-of-speech stage, measured: last words to turn sent.
          log(`turn sent ${Date.now() - context.resultAt}ms after the last words`);
          ls.push('history_prompts', text);
          setSaid(text);
          setInterim('');
          setTurnNo((n) => n + 1);
          post({ type: 'complete', text, startAt: heard.current.startAt, endAt: Date.now() });
          heard.current.final = '';
          send({ type: 'LISTEN_DONE' });
        },
        deliver: (_, { text, source, interrupted }) => {
          clearTimeout(listen.current.idleTimer);
          ls.push('history_prompts', text);
          setSaid(text);
          setInterim('');
          setTurnNo((n) => n + 1);
          heard.current.final = '';
          // The cut-off tts already returns this turn: its end must not open a listen.
          if (interrupted) listen.current.after = false;
          const now = Date.now();
          post({
            type: 'complete',
            text,
            startAt: now,
            endAt: now,
            source,
            ...(interrupted ? { interrupted } : {}),
          });
        },
        stopAudio: () => {
          audio.current?.pause();
          speechSynthesis.cancel();
        },
        playClip: (_, { clip }) => void playClip(clip),
        // Clips ahead synthesise while the current one plays, so the next starts with no gap.
        prefetchClips: (_, { clips }) => {
          for (const c of clips) fetchClip(c);
        },
        log: (_, { line }) => log(line),
        speakFallback: (_, { clip }) => {
          const u = new SpeechSynthesisUtterance(clip);
          const v = speechSynthesis.getVoices().find((x) => x.name === voice && x.localService);
          if (v) u.voice = v;
          u.rate = Number(rate);
          u.onend = () => send({ type: 'CLIP_ENDED' });
          spokenLog.current.push({ text: clip, at: Date.now() });
          speechSynthesis.speak(u);
        },
      },
    }),
  );
  const turn = (state.value as { turn: Turn }).turn;
  const paused = state.matches({ mic: 'paused' });
  const armed = state.matches({ autosend: 'armed' });

  // One synthesis per clip text: a prefetch and the later play share it.
  // The audio is cached, not the Response: a body reads once, so two equal sentences in a row
  // shared one Response and the second failed into the browser voice.
  function fetchClip(clip: string): Promise<Blob | string> {
    let p = clipCache.current.get(clip);
    if (!p) {
      p = (async (): Promise<Blob | string> => {
        const r = await fetch('/voice/clip', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: clip, voice: clipVoice, rate: Number(rate) }),
        }).catch(() => null);
        if (!r) return 'clip unreachable';
        return r.ok ? await r.blob() : `clip ${r.status} ${clipVoice}`;
      })();
      clipCache.current.set(clip, p);
    }
    return p;
  }

  async function playClip(clip: string): Promise<void> {
    const r = await fetchClip(clip);
    clipCache.current.delete(clip);
    if (typeof r === 'string') {
      send({ type: 'CLIP_FAILED', reason: r });
      return;
    }
    const a = new Audio(URL.createObjectURL(r));
    audio.current = a;
    a.onended = () => {
      setSpoken((s) => ({ ...s, done: s.done + 1 }));
      send({ type: 'CLIP_ENDED' });
    };
    spokenLog.current.push({ text: clip, at: Date.now() });
    a.play().catch((e: unknown) => send({ type: 'CLIP_FAILED', reason: `play ${String(e)}` }));
  }

  async function playEarcon(name: string): Promise<void> {
    if (earcons !== '1') return;
    const a = new Audio(`/earcon/${name}.ogg`);
    a.volume = Number(earconVol);
    await new Promise<void>((done) => {
      a.onended = () => done();
      a.play().catch(() => done());
    });
  }

  /** On-device en-US when Chrome has it; downloadable starts the install and uses the cloud meanwhile. */
  async function pickLocal(SR: RecognitionStatics): Promise<boolean> {
    if (!SR.available) return true;
    const st = await SR.available(LOCAL_EN).catch(() => 'unavailable');
    log(`mic on-device ${st}`);
    if (st === 'available') return true;
    if (st === 'downloadable' && SR.install) {
      SR.install(LOCAL_EN)
        .then((ok) => {
          log(`mic on-device install ${ok}`);
          if (ok) local.current = true;
        })
        .catch((e: unknown) => log(`mic on-device install failed ${String(e)}`));
    }
    return false;
  }

  async function startMic(): Promise<void> {
    // The chime first, so it is never recorded and the listen always opens after it.
    // Not over the agent's speech: the mic opening there is silent.
    const snap = actor.getSnapshot();
    if (!snap.matches({ speech: 'playing' }) && !snap.context.auto) await playEarcon('listen-open');
    // Paused, or the listen ended, during the chime: the mic must not start.
    const stillStarting = () => actor.getSnapshot().matches({ mic: { live: 'starting' } });
    if (!stillStarting()) return;
    const SR = (
      globalThis as unknown as {
        SpeechRecognition?: new () => Recognition;
        webkitSpeechRecognition?: new () => Recognition;
      }
    ).SpeechRecognition;
    const Ctor =
      SR ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) {
      log('mic error no SpeechRecognition');
      send({ type: 'MIC_ERROR' });
      return;
    }
    local.current ??= await pickLocal(Ctor as unknown as RecognitionStatics);
    if (!stillStarting()) return;
    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, ...(mic === 'default' ? {} : { deviceId: mic }) },
      })
      .catch(() => null);
    if (!stillStarting()) {
      for (const t of stream?.getTracks() ?? []) t.stop();
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.processLocally = local.current;
    micStream.current = stream;
    // A stopped recogniser still fires its end and error late; only the current one may move
    // the machine, or a dead one's end marks the new mic as stopped.
    const mine = (): boolean => rec.current === r;
    r.onstart = () => mine() && send({ type: 'MIC_STARTED' });
    r.onend = () => mine() && send({ type: 'MIC_ENDED' });
    r.onerror = (e) => {
      if (!mine()) return;
      log(`mic error ${e.error ?? 'unknown'}`);
      // On-device refused the language: the next start uses cloud recognition.
      if (e.error === LANG_ERR) local.current = false;
      send({ type: 'MIC_ERROR', ...(e.error ? { error: e.error } : {}) });
    };
    r.onaudiostart = () => mine() && send({ type: 'AUDIO' });
    r.onspeechstart = () => {
      if (!mine()) return;
      heard.current.startAt ||= Date.now();
      send({ type: 'SPEECH_START' });
    };
    r.onspeechend = () => mine() && send({ type: 'SPEECH_END', text: heard.current.final });
    r.onresult = (e) => {
      if (!mine()) return;
      let live = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res?.[0]?.transcript ?? '';
        if (res?.isFinal) final = `${final} ${t}`.trim();
        else live += t;
      }
      // While the agent speaks only a final of 3+ words that is not its own echo cuts it off.
      const snap = actor.getSnapshot();
      if (snap.matches({ speech: 'playing' })) {
        if (!final) return;
        const clip = snap.context.queue[0] ?? '';
        const startedAt = spokenLog.current.findLast((x) => x.text === clip)?.at ?? 0;
        const v = bargeVerdict(final, [clip, ...recentSpoken()], Date.now() - startedAt);
        if (v === 'barge') send({ type: 'BARGE', text: final, part: listen.current.part });
        else if (v === 'echo' && echoLogged.current !== clip) {
          echoLogged.current = clip;
          log('echo discarded');
        }
        return;
      }
      // A final landing just after speech ended is still the tail of its echo.
      if (final && isEcho(final, recentSpoken())) {
        log('echo discarded');
        final = '';
        if (!live) return;
      }
      if (final) heard.current.final = `${heard.current.final} ${final}`.trim();
      setInterim(`${heard.current.final} ${live}`.trim());
      // Words still forming cancel an armed autosend; a settled final arms it.
      send({ type: live ? 'INTERIM' : 'RESULT', text: heard.current.final });
    };
    rec.current = r;
    const track = stream?.getAudioTracks()[0];
    try {
      if (track) r.start(track);
      else r.start();
    } catch {
      send({ type: 'MIC_ERROR' });
    }
  }

  // The daemon link.
  // biome-ignore lint/correctness/useExhaustiveDependencies: post and log only read the ws ref; reconnecting on every render would drop the link.
  useEffect(() => {
    // Live update (spec 013): the daemon restarts on a newer install between turns. The page
    // reconnects; when the daemon's folder changed it reloads for the new code once it is quiet
    // (no speech playing, no words heard), and the daemon resends the open listen on "ready".
    let dead = false;
    let dir = '';
    let resumed = false;
    const daemonDir = async (): Promise<string | null> => {
      const r = await fetch('/api/ping', { cache: 'no-store' }).catch(() => null);
      return r?.ok ? (r.headers.get('X-Stts-Dir') ?? '') : null;
    };
    const quiet = (): boolean => actor.getSnapshot().matches({ speech: 'idle' }) && !heard.current.final;
    const reloadWhenQuiet = (): void => {
      if (dead) return;
      if (quiet()) location.reload();
      else setTimeout(reloadWhenQuiet, 500);
    };
    const reconnect = async (): Promise<void> => {
      if (dead) return;
      const d = await daemonDir();
      if (d === null) {
        setTimeout(() => void reconnect(), 500);
        return;
      }
      resumed = true;
      connect();
      if (dir && d !== dir) {
        log('live update: reloading for the new version');
        reloadWhenQuiet();
      }
    };
    void daemonDir().then((d) => {
      dir = d ?? '';
    });
    const connect = (): void => {
      const sock = new WebSocket(`ws://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'ready' }));
      sock.onmessage = onMessage;
      sock.onclose = () => {
        if (dead) return;
        log('ws closed');
        setTimeout(() => void reconnect(), 300);
      };
    };
    const onMessage = (e: MessageEvent): void => {
      const m = parseMessage(DaemonMessage, String(e.data));
      if (!m) return;
      clearTimeout(listen.current.idleTimer);
      if (m.type === 'released') {
        actor.send({ type: m.reason === 'background' ? 'NOTIFY' : 'LISTEN_DONE', text: '' });
        return;
      }
      const b = m.body;
      listen.current.part = b.part ?? 1;
      if (raise === '1') window.focus();
      if (b.kind === 'stt') {
        actor.send({ type: 'REQUEST', kind: 'listen' });
        // The same listen resent after a reconnect keeps the words already heard.
        armIdle(b.idleSec ?? 200, resumed);
        resumed = false;
        return;
      }
      resumed = false;
      // Short clips: Piper renders a whole clip before it plays, so a 1000-char first clip
      // held the first word 2-5 s (log, 2026-10-05). The rest synthesise ahead while it plays.
      const clips = toParts(b.text ?? '', CLIP_CHARS);
      ls.push('history_responses', b.text ?? '');
      setSaid(b.text ?? '');
      setSpoken({ done: 0, of: clips.length });
      setInterim('');
      listen.current.after = b.listen === true;
      listen.current.idleSec = b.idleSec ?? 200;
      actor.send({ type: 'ENQUEUE', clips, listen: b.listen === true });
    };
    connect();
    return () => {
      dead = true;
      ws.current?.close();
    };
  }, [actor, raise]);

  // Speech queue drained: a plain tts is done; a tts with listen opens the mic next.
  // The edge from playing to idle, read off the machine: a closure over the spoken count
  // went stale and never answered the tts (live test, 2026-10-05).
  // biome-ignore lint/correctness/useExhaustiveDependencies: post only reads the ws ref; one subscription per actor.
  useEffect(() => {
    let wasPlaying = false;
    const s2 = actor.subscribe((s) => {
      const playing = s.matches({ speech: 'playing' });
      if (wasPlaying && !playing) {
        setSpoken({ done: 0, of: 0 });
        if (listen.current.after) {
          actor.send({ type: 'REQUEST', kind: 'listen' });
          // The listen after a tts gets the same no-speech timer as an stt.
          armIdle(listen.current.idleSec);
        } else post({ type: 'complete', text: '', startAt: 0, endAt: 0 });
      }
      wasPlaying = playing;
    });
    return () => s2.unsubscribe();
  }, [actor]);

  // Earcon once per state change (the listen-open chime plays in startMic).
  const lastTurn = useRef<Turn>(turn);
  useEffect(() => {
    if (lastTurn.current === turn) return;
    lastTurn.current = turn;
    // The light's every change in the log, so a wrong colour can be traced to its event.
    log(`light ${turn}`);
    const name = EARCON[turn];
    if (name && name !== 'listen-open') void playEarcon(name);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: post only reads the ws ref; runs on each mute change.
  useEffect(() => {
    document.title = paused ? 'stts (muted)' : 'stts';
    // Unmuted: ask the daemon for any open listen again, so the mic comes back even if the page lost it.
    if (!paused) post({ type: 'relisten' });
  }, [paused]);

  useEffect(() => {
    actor.send({ type: 'SET_AUTOSEND', on: autosend === '1' });
  }, [actor, autosend]);

  useEffect(() => {
    actor.send({ type: 'SET_HOLD', ms: hold ? Number(hold) : null });
  }, [actor, hold]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once; the warm-up uses the voice saved at load.
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId)))
      .catch(() => {});
    const fill = () =>
      setLocalVoices(
        speechSynthesis
          .getVoices()
          .filter((v) => v.localService)
          .map((v) => v.name),
      );
    fill();
    fetch('/voice/list')
      .then((r) => r.json() as Promise<string[]>)
      .then((l) => {
        if (l.length) setPiperVoices(l);
        void fetch('/voice/warm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: l.includes(voice) ? voice : DEFAULT_PIPER }),
        }).catch(() => {});
      })
      .catch(() => {});
    speechSynthesis.addEventListener('voiceschanged', fill);
    return () => speechSynthesis.removeEventListener('voiceschanged', fill);
  }, []);

  // Ctrl+M / Ctrl+R toggle the mic; Alt+Up/Down walk the history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'm' || e.key === 'r')) {
        e.preventDefault();
        actor.send({ type: paused ? 'RESUME' : 'PAUSE', trusted: e.isTrusted });
        log(paused ? 'resumed by Mark' : 'paused by Mark');
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        setBrowse((b) => {
          const side = b?.side ?? 'prompts';
          const n = ls.list(`history_${side}`).length;
          const i = Math.max(0, Math.min(n, (b?.i ?? n) + (e.key === 'ArrowUp' ? -1 : 1)));
          return i >= n ? null : { side, i };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // History browsing fills the box in keyboard mode, so an old prompt can be sent again.
  useEffect(() => {
    if (browse?.side === 'prompts' && inputMode === 'keyboard') setDraft(ls.list('history_prompts')[browse.i] ?? '');
  }, [browse, inputMode]);

  const typeDraft = (text: string): void => {
    setDraft(text);
    actor.send({ type: 'SET_TYPING', on: text.trim() !== '' });
  };
  const sendDraft = (): void => {
    const text = draft.trim();
    if (!text) return;
    actor.send({ type: 'TYPED', text, part: listen.current.part });
    setBrowse(null);
    typeDraft('');
  };

  const shown = browse ? (ls.list(`history_${browse.side}`)[browse.i] ?? '') : interim || said;
  const micFailed = state.matches({ mic: { live: 'failed' } });
  const StatusIcon = micFailed
    ? CircleAlert
    : paused
      ? MicOff
      : turn === 'agentSpeaking'
        ? Volume2
        : turn === 'background'
          ? Bell
          : turn === 'heard'
            ? Ear
            : Mic;
  const holdSec = holdMs(state.context) / 1000;

  return (
    <main className="@container relative flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 p-[clamp(0.25rem,2cqw,1rem)]">
        <span
          className="rounded-full px-3 py-1 font-mono text-sm font-semibold text-neutral-950"
          style={{ background: TINT[turn][0] }}
        >
          {turnNo}
        </span>
        <StatusIcon
          aria-label={micFailed ? 'mic error' : paused ? 'muted' : turn}
          className="size-6"
          style={{ color: micFailed ? '#ef4444' : TINT[turn][0] }}
        />
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={inputMode === 'keyboard' ? 'Switch to mic input' : 'Switch to keyboard input'}
            onClick={() => setInputMode(inputMode === 'keyboard' ? 'mic' : 'keyboard')}
          >
            {inputMode === 'keyboard' ? <AudioLines /> : <Keyboard />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={paused ? 'Unmute' : 'Mute'}
            onClick={(e) => actor.send({ type: paused ? 'RESUME' : 'PAUSE', trusted: e.nativeEvent.isTrusted })}
          >
            {paused ? <MicOff /> : <Mic />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Stop"
            onClick={(e) => {
              if (!e.nativeEvent.isTrusted) return;
              audio.current?.pause();
              listen.current.after = false;
              send({ type: 'STOP' });
              speechSynthesis.cancel();
              post({ type: 'stopped', part: listen.current.part });
            }}
          >
            <CircleStop />
          </Button>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
              <Settings2 />
            </PopoverTrigger>
            <PopoverContent className="grid w-[min(18rem,calc(100vw-1rem))] gap-4">
              <Row label="Theme">
                <Select value={theme} onValueChange={(v) => v && setTheme(String(v))}>
                  <SelectTrigger className="w-40 max-w-full" aria-label="Theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Voice">
                <Select value={voice} onValueChange={(v) => v && setVoice(String(v))}>
                  <SelectTrigger className="w-40 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...piperVoices, ...localVoices].map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row label={`Rate ${rate}`}>
                <Slider
                  className="w-40 max-w-full"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={[Number(rate)]}
                  onValueChange={(v) => setRate(String(first(v)))}
                />
              </Row>
              <Row label="Auto-send">
                <Switch
                  checked={autosend === '1' && !paused}
                  disabled={paused}
                  onCheckedChange={(c) => setAutosend(c ? '1' : '0')}
                />
              </Row>
              <Row label={hold ? `Hold ${hold} ms` : 'Hold auto'}>
                <Slider
                  className="w-40 max-w-full"
                  min={300}
                  max={3000}
                  step={100}
                  value={[Number(hold || 1000)]}
                  onValueChange={(v) => setHold(String(first(v)))}
                />
              </Row>
              <Row label="Mic">
                <Select value={mic} onValueChange={(v) => v && setMic(String(v))}>
                  <SelectTrigger className="w-40 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">default</SelectItem>
                    {mics.map((m) => (
                      <SelectItem key={m.deviceId} value={m.deviceId}>
                        {m.label || m.deviceId.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Earcons">
                <Switch checked={earcons === '1'} onCheckedChange={(c) => setEarcons(c ? '1' : '0')} />
              </Row>
              <Row label="Earcon volume">
                <Slider
                  className="w-40 max-w-full"
                  min={0}
                  max={1}
                  step={0.05}
                  value={[Number(earconVol)]}
                  onValueChange={(v) => setEarconVol(String(first(v)))}
                />
              </Row>
              <Row label="Raise on request">
                <Switch checked={raise === '1'} onCheckedChange={(c) => setRaise(c ? '1' : '0')} />
              </Row>
            </PopoverContent>
          </Popover>
          <Button
            variant="destructive"
            size="icon"
            aria-label="End conversation"
            onClick={(e) => {
              if (e.nativeEvent.isTrusted) post({ type: 'ended' });
            }}
          >
            <PhoneOff />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col @min-[1200px]:flex-row">
        {/* The orb has its own row (a column at 1200 px and up) and shrinks to fit it: nothing overlaps. */}
        <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden [container-type:size] [mask-image:radial-gradient(circle,black_40%,transparent_75%)]">
          {turn === 'speakNow' && <Ripple mainCircleSize={260} className="opacity-70" />}
          <div data-orb className="relative aspect-square size-[min(100cqw,100cqh)]">
            <Orb className="absolute inset-[12%]" colors={TINT[turn]} agentState={ORB_STATE[turn]} />
            <svg
              className="pointer-events-none absolute inset-[8%] -rotate-90"
              viewBox="0 0 100 100"
              aria-hidden="true"
            >
              {armed && (
                <motion.circle
                  key={state.context.transcript}
                  cx="50"
                  cy="50"
                  r="48"
                  fill="none"
                  stroke={TINT[turn][0]}
                  strokeWidth="1.5"
                  initial={{ pathLength: 1 }}
                  animate={{ pathLength: 0 }}
                  transition={{ duration: holdSec, ease: 'linear' }}
                />
              )}
            </svg>
          </div>
        </div>
        <section className="relative max-h-[50%] shrink-0 overflow-y-auto px-[clamp(0.5rem,4cqw,1.5rem)] text-center @min-[1200px]:my-auto @min-[1200px]:max-h-full @min-[1200px]:w-[32cqw] @min-[1200px]:text-left">
          {interim && !browse ? (
            <TextShimmer className="text-[clamp(1rem,0.85rem+1.6cqw,1.75rem)] font-medium [--base-color:var(--muted-foreground)] [--base-gradient-color:var(--foreground)]">
              {interim}
            </TextShimmer>
          ) : (
            <p className="text-[clamp(1rem,0.85rem+1.6cqw,1.75rem)] font-medium text-foreground/90">{shown}</p>
          )}
        </section>
      </div>

      {/* In the flow, its height always reserved: the words above can never run under the wave. */}
      <div data-wave className="relative h-24 shrink-0 opacity-80">
        {turn === 'agentSpeaking' && (
          <>
            <LiveWaveform processing mode="static" height={96} barColor={TINT.agentSpeaking[0]} />
            {spoken.of > 1 && (
              <Progress value={(spoken.done / spoken.of) * 100} className="absolute inset-x-8 bottom-2" />
            )}
          </>
        )}
      </div>

      {inputMode === 'keyboard' && (
        <form
          className="relative mx-2 mb-2 flex shrink-0 flex-col items-stretch gap-2 @min-[360px]:flex-row @min-[360px]:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            sendDraft();
          }}
        >
          <Textarea
            aria-label="Message"
            placeholder="Message (Enter sends)"
            className="max-h-40 min-w-0 bg-card/80 text-[clamp(0.875rem,0.8rem+0.6cqw,1rem)] placeholder:truncate"
            autoFocus
            value={draft}
            onChange={(e) => typeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendDraft();
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            disabled={!draft.trim()}
            className="w-full @min-[360px]:w-9"
          >
            <SendHorizontal />
          </Button>
        </form>
      )}
    </main>
  );
}

const first = (v: number | readonly number[]): number => (typeof v === 'number' ? v : (v[0] ?? 0));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}
