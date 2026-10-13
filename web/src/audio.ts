import backgroundMusicUrl from "./assets/music/bg.mp3?url";
import winnerMusicUrl from "./assets/music/winner.mp3?url";
import failedMusicUrl from "./assets/music/failed.mp3?url";

export type MusicTrack = "background" | "winner" | "failed";
const musicUrls = { background: backgroundMusicUrl, winner: winnerMusicUrl, failed: failedMusicUrl };

let context: AudioContext | null = null;
let lastSound = 0;
let musicWanted: MusicTrack | null = null;
const musicBuffers = new Map<MusicTrack, Promise<AudioBuffer>>();
let musicSource: AudioBufferSourceNode | undefined;
let musicGain: GainNode | undefined;
let musicGeneration = 0;

async function playBackgroundMusic() {
  const audio = context;
  if (!musicWanted || !audio || audio.state !== "running" || musicSource) return;
  const generation = musicGeneration;
  const track = musicWanted;
  try {
    let loading = musicBuffers.get(track);
    if (!loading) {
      loading = fetch(musicUrls[track]).then(response => {
        if (!response.ok) throw new Error("Background music unavailable");
        return response.arrayBuffer();
      }).then(data => audio.decodeAudioData(data));
      musicBuffers.set(track, loading);
    }
    const buffer = await loading;
    if (musicWanted !== track || generation !== musicGeneration || audio !== context || audio.state !== "running" || musicSource) return;
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    source.loop = track === "background";
    gain.gain.value = .6;
    source.connect(gain);
    gain.connect(audio.destination);
    source.start();
    musicSource = source;
    musicGain = gain;
  } catch {
    musicBuffers.delete(track); // Retry a failed download on the next gesture.
  }
}

export function startBackgroundMusic(track: MusicTrack = "background") {
  if (musicWanted !== track) stopBackgroundMusic();
  musicWanted = track;
  unlockAudio();
}

export function stopBackgroundMusic() {
  musicWanted = null;
  musicGeneration++;
  if (musicSource) {
    try { musicSource.stop(); } catch { /* Already stopped. */ }
    musicSource.disconnect();
    musicGain?.disconnect();
    musicSource = undefined;
    musicGain = undefined;
  }
}

export function unlockAudio() {
  try {
    if (!context || context.state === "closed") context = new AudioContext();
    if (context.state !== "running") {
      void context.resume().then(playBackgroundMusic).catch(() => {});
      const prime = context.createBufferSource();
      prime.buffer = context.createBuffer(1, 1, context.sampleRate);
      prime.connect(context.destination);
      prime.onended = () => prime.disconnect();
      prime.start();
    }
    void playBackgroundMusic();
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
