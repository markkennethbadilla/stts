// The orb screen (brief section 6): a full-bleed orb tinted by the turn state, wired to
// web/machine.ts. The machine decides; this file only supplies its side effects.
import { useMachine } from '@xstate/react';
import { Bell, CircleStop, Ear, Mic, MicOff, PhoneOff, Settings2, Volume2 } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { DaemonMessage, type PageMessage, parseMessage, readsUnfinished } from '../src/protocol.ts';
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
import { pageMachine } from './machine.ts';

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
  const heard = useRef({ final: '', startAt: 0 });
  const listen = useRef({ part: 1, after: false, idleTimer: 0 });
  const audio = useRef<HTMLAudioElement | null>(null);
  const [interim, setInterim] = useState('');
  const [said, setSaid] = useState('');
  const [turnNo, setTurnNo] = useState(0);
  const [spoken, setSpoken] = useState({ done: 0, of: 0 });
  const [browse, setBrowse] = useState<{ side: 'prompts' | 'responses'; i: number } | null>(null);
  const [voice, setVoice] = useSetting('voice', DEFAULT_PIPER);
  const [rate, setRate] = useSetting('rate', '1');
  const [autosend, setAutosend] = useSetting('autosend', '1');
  const [hold, setHold] = useSetting('hold_ms', '1000');
  const [mic, setMic] = useSetting('mic', 'default');
  const [earcons, setEarcons] = useSetting('earcons', '1');
  const [earconVol, setEarconVol] = useSetting('earcon_vol', '0.5');
  const [raise, setRaise] = useSetting('raise', '0');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [localVoices, setLocalVoices] = useState<string[]>([]);

  const post = (m: PageMessage): void => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };
  const log = (line: string): void => post({ type: 'log', line });

  const [state, send, actor] = useMachine(
    pageMachine.provide({
      actions: {
        startMic: () => void startMic(),
        // A mic restart must not cancel the listen's idle timer, so stopMic leaves it alone.
        stopMic: () => rec.current?.stop(),
        sendTurn: (_, { text }) => {
          clearTimeout(listen.current.idleTimer);
          ls.push('history_prompts', text);
          setSaid(text);
          setInterim('');
          setTurnNo((n) => n + 1);
          post({ type: 'complete', text, startAt: heard.current.startAt, endAt: Date.now() });
          heard.current.final = '';
          send({ type: 'LISTEN_DONE' });
        },
        playClip: (_, { clip }) => void playClip(clip),
        prefetchClips: () => {},
        log: (_, { line }) => log(line),
        speakFallback: (_, { clip }) => {
          const u = new SpeechSynthesisUtterance(clip);
          const v = speechSynthesis.getVoices().find((x) => x.name === voice && x.localService);
          if (v) u.voice = v;
          u.rate = Number(rate);
          u.onend = () => send({ type: 'CLIP_ENDED' });
          speechSynthesis.speak(u);
        },
      },
    }),
  );
  const turn = (state.value as { turn: Turn }).turn;
  const paused = state.matches({ mic: 'paused' });
  const armed = state.matches({ autosend: 'armed' });

  async function playClip(clip: string): Promise<void> {
    const r = await fetch('/voice/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clip, voice, rate: Number(rate) }),
    }).catch(() => null);
    if (!r?.ok) {
      send({ type: 'CLIP_FAILED' });
      return;
    }
    const a = new Audio(URL.createObjectURL(await r.blob()));
    audio.current = a;
    a.onended = () => {
      setSpoken((s) => ({ ...s, done: s.done + 1 }));
      send({ type: 'CLIP_ENDED' });
    };
    a.play().catch(() => send({ type: 'CLIP_FAILED' }));
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

  async function startMic(): Promise<void> {
    // The chime first, so it is never recorded and the listen always opens after it.
    await playEarcon('listen-open');
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
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, ...(mic === 'default' ? {} : { deviceId: mic }) } })
      .catch(() => null);
    if (!stillStarting()) {
      for (const t of stream?.getTracks() ?? []) t.stop();
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.processLocally = true;
    r.onstart = () => send({ type: 'MIC_STARTED' });
    r.onend = () => send({ type: 'MIC_ENDED' });
    r.onerror = (e) => {
      log(`mic error ${e.error ?? 'unknown'}`);
      send({ type: 'MIC_ERROR' });
    };
    r.onaudiostart = () => send({ type: 'AUDIO' });
    r.onspeechstart = () => {
      heard.current.startAt ||= Date.now();
      send({ type: 'SPEECH_START' });
    };
    r.onspeechend = () => send({ type: 'SPEECH_END', text: heard.current.final });
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res?.[0]?.transcript ?? '';
        if (res?.isFinal) heard.current.final = `${heard.current.final} ${t}`.trim();
        else live += t;
      }
      setInterim(`${heard.current.final} ${live}`.trim());
      send({ type: 'RESULT', text: heard.current.final });
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
    const sock = new WebSocket(`ws://${location.host}/ws`);
    ws.current = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'ready' }));
    sock.onmessage = (e) => {
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
        const idle = (b.idleSec ?? 200) * 1000;
        if (idle > 0) {
          listen.current.idleTimer = window.setTimeout(() => {
            if (!heard.current.final) post({ type: 'nospeech' });
          }, idle);
        }
        return;
      }
      const clips = toParts(b.text ?? '');
      ls.push('history_responses', b.text ?? '');
      setSaid(b.text ?? '');
      setSpoken({ done: 0, of: clips.length });
      setInterim('');
      listen.current.after = b.listen === true;
      actor.send({ type: 'ENQUEUE', clips });
    };
    sock.onclose = () => log('ws closed');
    return () => sock.close();
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
        if (listen.current.after) actor.send({ type: 'REQUEST', kind: 'listen' });
        else post({ type: 'complete', text: '', startAt: 0, endAt: 0 });
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
    const name = EARCON[turn];
    if (name && name !== 'listen-open') void playEarcon(name);
  });

  useEffect(() => {
    document.title = paused ? 'stts (muted)' : 'stts';
  }, [paused]);

  useEffect(() => {
    actor.send({ type: 'SET_AUTOSEND', on: autosend === '1' });
  }, [actor, autosend]);

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

  const shown = browse ? (ls.list(`history_${browse.side}`)[browse.i] ?? '') : interim || said;
  const StatusIcon = paused
    ? MicOff
    : turn === 'agentSpeaking'
      ? Volume2
      : turn === 'background'
        ? Bell
        : turn === 'heard'
          ? Ear
          : Mic;
  const holdSec = readsUnfinished(state.context.transcript) ? 1 : 0.7;

  return (
    <main className="@container relative grid h-dvh w-full overflow-hidden bg-neutral-950 text-neutral-50">
      <div className="absolute inset-0 grid place-items-center [mask-image:radial-gradient(circle,black_40%,transparent_75%)]">
        <div className="relative aspect-square h-[min(90cqh,90cqw)] @min-[1200px]:h-[110cqh]">
          {turn === 'speakNow' && <Ripple mainCircleSize={260} className="opacity-70" />}
          <Orb className="absolute inset-[12%]" colors={TINT[turn]} agentState={ORB_STATE[turn]} />
          <svg className="pointer-events-none absolute inset-[8%] -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
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

      {turn === 'agentSpeaking' && (
        <div className="absolute inset-x-0 bottom-0 h-24 opacity-80">
          <LiveWaveform processing mode="static" height={96} barColor={TINT.agentSpeaking[0]} />
          {spoken.of > 1 && (
            <Progress value={(spoken.done / spoken.of) * 100} className="absolute inset-x-8 bottom-2" />
          )}
        </div>
      )}

      <header className="absolute inset-x-0 top-0 flex items-center gap-3 p-4">
        <span
          className="rounded-full px-3 py-1 font-mono text-sm font-semibold text-neutral-950"
          style={{ background: TINT[turn][0] }}
        >
          {turnNo}
        </span>
        <StatusIcon aria-label={paused ? 'muted' : turn} className="size-6" style={{ color: TINT[turn][0] }} />
        <div className="ml-auto flex gap-2">
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
            <PopoverContent className="grid w-72 gap-4">
              <Row label="Voice">
                <Select value={voice} onValueChange={(v) => v && setVoice(String(v))}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[DEFAULT_PIPER, ...localVoices].map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row label={`Rate ${rate}`}>
                <Slider
                  className="w-40"
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
              <Row label={`Hold ${hold} ms`}>
                <Slider
                  className="w-40"
                  min={300}
                  max={3000}
                  step={100}
                  value={[Number(hold)]}
                  onValueChange={(v) => setHold(String(first(v)))}
                />
              </Row>
              <Row label="Mic">
                <Select value={mic} onValueChange={(v) => v && setMic(String(v))}>
                  <SelectTrigger className="w-40">
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
                  className="w-40"
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

      <section className="absolute inset-x-0 bottom-28 px-6 text-center @min-[1200px]:bottom-auto @min-[1200px]:left-auto @min-[1200px]:top-1/2 @min-[1200px]:w-[32cqw] @min-[1200px]:-translate-y-1/2 @min-[1200px]:text-left">
        {interim && !browse ? (
          <TextShimmer className="text-2xl font-medium [--base-color:theme(colors.neutral.400)] [--base-gradient-color:white]">
            {interim}
          </TextShimmer>
        ) : (
          <p className="text-2xl font-medium text-neutral-200">{shown}</p>
        )}
      </section>
    </main>
  );
}

const first = (v: number | readonly number[]): number => (typeof v === 'number' ? v : (v[0] ?? 0));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}
