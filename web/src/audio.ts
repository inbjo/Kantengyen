let context: AudioContext | null = null;
let lastSound = 0;
export function unlockAudio() {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch { /* Unsupported or blocked audio must not interrupt play. */ }
}
export function playCardSound(kind: string) {
  if (!context || context.state !== "running" || performance.now() - lastSound < 100) return;
  lastSound = performance.now();
  const notes = kind === "bomb" || kind === "deep_bomb" ? [150, 90, 55]
    : kind === "two" ? [520, 780, 1040]
    : kind === "straight" ? [330, 440, 550, 660]
    : kind === "pair" ? [440, 550]
    : kind === "win" ? [440, 550, 660, 880] : [460];
  const bass = kind === "bomb" || kind === "deep_bomb";
  notes.forEach((frequency, i) => {
    const start = context!.currentTime + i * (bass ? .08 : .06);
    const duration = bass ? .22 : .12;
    const oscillator = context!.createOscillator();
    const gain = context!.createGain();
    oscillator.type = bass ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    if (bass) oscillator.frequency.exponentialRampToValueAtTime(frequency / 2, start + duration);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(bass ? .09 : .045, start + .012);
    gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    oscillator.connect(gain);
    gain.connect(context!.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + duration + .01);
  });
}
