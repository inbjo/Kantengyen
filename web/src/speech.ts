/// <reference types="vite/client" />
import type { Pattern } from "./types";

// Wording is also used by tests and remains independent of the recorded clips.
export function cardAnnouncement(pattern: Pattern): string {
  const rank = ({ 11: "勾", 12: "圈", 13: "K", 14: "尖", 15: "二" } as Record<number, string>)[pattern.rank]
    ?? ["", "", "", "三", "四", "五", "六", "七", "八", "九", "十"][pattern.rank];
  switch (pattern.kind) {
    case "single": return rank ?? "";
    case "pair": return rank ? `对${rank}` : "";
    case "straight": return "顺子";
    case "bomb": return "炸弹";
    case "deep_bomb": return "四张炸弹";
  }
}

const clips = import.meta.glob<string>("./assets/announcements/*.wav", {
  eager: true, query: "?url", import: "default",
});
const buffers = new Map<string, Promise<AudioBuffer | undefined>>();
let context: AudioContext | undefined;
let current: { source: AudioBufferSourceNode; gain: GainNode } | undefined;
let generation = 0;
let resuming: Promise<void> | undefined;

function loadClip(key: string): Promise<AudioBuffer | undefined> {
  const url = clips[`./assets/announcements/${key}.wav`];
  if (!context || !url) return Promise.resolve(undefined);
  let pending = buffers.get(key);
  if (!pending) {
    const audio = context;
    pending = fetch(url).then(response => {
      if (!response.ok) throw new Error("Announcement unavailable");
      return response.arrayBuffer();
    }).then(data => audio.decodeAudioData(data)).catch(() => {
      buffers.delete(key); // Allow retry after an interrupted download.
      return undefined;
    });
    buffers.set(key, pending);
  }
  return pending;
}
export function stopAnnouncement() {
  generation++; // Invalidate downloads still in flight, too.
  if (current) {
    current.source.onended = null;
    try { current.source.stop(); } catch { /* Already ended. */ }
    current.source.disconnect();
    current.gain.disconnect();
    current = undefined;
  }
}
export function unlockSpeech() {
  try {
    const needsPrime = !context || context.state !== "running";
    if (!context || context.state === "closed") {
      resuming = undefined;
      context = new AudioContext();
      buffers.clear();
    }
    if (context.state !== "running") {
      // Retry within each valid gesture even if an earlier non-gesture resume
      // is still pending; mobile browsers may leave that promise unresolved.
      const previousResume = resuming;
      // A rejected follow-up click must not discard a valid touch resume that
      // is still in flight.
      const pending = context.resume().catch(() => previousResume).finally(() => {
        if (resuming === pending) resuming = undefined;
      });
      resuming = pending;
    }
    if (needsPrime) {
      // Prime again after an interruption, inside a valid touch/mouse gesture.
      const prime = context.createBufferSource();
      prime.buffer = context.createBuffer(1, 1, context.sampleRate);
      prime.connect(context.destination);
      prime.onended = () => prime.disconnect();
      prime.start();
    }
    for (const path of Object.keys(clips)) {
      void loadClip(path.slice(path.lastIndexOf("/") + 1, -4));
    }
  } catch { /* Audio support must not interrupt the game. */ }
}
export function announceCard(pattern: Pattern) {
  const key = pattern.kind === "single" || pattern.kind === "pair"
    ? `${pattern.kind}-${pattern.rank}` : pattern.kind;
  announceSequence([key]);
}

// Short related cues may follow a card, but every new event replaces the sequence.
export function announceSequence(keys: string[]) {
  stopAnnouncement();
  if (!context || document.hidden || (context.state !== "running" && !resuming)) return;
  const requested = generation;
  const playNext = (index: number) => {
    if (index >= keys.length) return;
    void loadClip(keys[index]).then(buffer => {
      if (requested !== generation || document.hidden || context?.state !== "running") return;
      if (!buffer) { playNext(index + 1); return; }
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = .75;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(context.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (current?.source === source) current = undefined;
        playNext(index + 1);
      };
      current = { source, gain };
      source.start();
    }).catch(() => { /* Failed playback must not interrupt the game. */ });
  };
  // A server snapshot can arrive while a mobile context is still resuming.
  void (resuming ?? Promise.resolve()).then(() => {
    if (requested === generation && !document.hidden && context?.state === "running") playNext(0);
  });
}
