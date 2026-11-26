// Headless Chrome's OS voice is shared across pages and stalls, so a clip ends on a fixed clock instead.
export function fakeVoice(clipMs: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: SpeechSynthesisUtterance[] = [];
  const next = (): void => {
    const u = queue[0];
    if (!u || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      queue.shift();
      u.onend?.(new Event('end') as SpeechSynthesisEvent);
      next();
    }, clipMs);
  };
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    speak: (u: SpeechSynthesisUtterance) => {
      queue.push(u);
      next();
    },
    cancel: () => {
      queue.length = 0;
      clearTimeout(timer);
      timer = undefined;
    },
    pause: () => {},
    resume: () => {},
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, 'speechSynthesis', { value: synth, configurable: true });
}
