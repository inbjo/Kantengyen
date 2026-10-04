import type { Pattern } from "./types";

// Keep wording separate from playback so recorded voice assets can replace TTS later.
export function cardAnnouncement(pattern: Pattern): string {
  const rank = ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "二" } as Record<number, string>)[pattern.rank]
    ?? ["", "", "", "三", "四", "五", "六", "七", "八", "九", "十"][pattern.rank];
  switch (pattern.kind) {
    case "single": return rank ?? "";
    case "pair": return rank ? `对${rank}` : "";
    case "straight": return "顺子";
    case "bomb": return "炸弹";
    case "deep_bomb": return "深水炸弹";
  }
}

let unlocked = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
function chineseVoice() {
  const voices = window.speechSynthesis.getVoices().filter(voice => /^zh(?:-|_)/i.test(voice.lang));
  return voices.find(voice => /^zh[-_]CN$/i.test(voice.lang)) ?? voices[0];
}
export function stopAnnouncement() {
  clearTimeout(watchdog);
  try { window.speechSynthesis?.cancel(); } catch { /* Optional browser feature. */ }
}
export function unlockSpeech() {
  if (unlocked || !("speechSynthesis" in window)) return;
  try {
    const voice = chineseVoice();
    if (!voice) return; // Retry on the next gesture if voices have not loaded yet.
    const prime = new SpeechSynthesisUtterance(" ");
    prime.voice = voice;
    prime.lang = voice.lang;
    prime.volume = 0;
    window.speechSynthesis.speak(prime);
    unlocked = true;
  } catch { /* Play remains usable without speech. */ }
}
export function announceCard(pattern: Pattern) {
  if (!unlocked || document.hidden || !("speechSynthesis" in window)) return;
  try {
    const voice = chineseVoice();
    const text = cardAnnouncement(pattern);
    if (!voice || !text) return;
    stopAnnouncement(); // Latest play wins; never build up a stale narration queue.
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 1.1;
    utterance.volume = 0.75;
    window.speechSynthesis.speak(utterance);
    watchdog = setTimeout(stopAnnouncement, 4000);
  } catch { /* Missing voices or synthesis errors must not interrupt the game. */ }
}
