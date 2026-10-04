function storageFor(key: string) {
  // Auth and room membership belong to this tab. Intro preferences may be shared.
  return key === "kantengyen.session" || key === "kantengyen.room"
    ? sessionStorage
    : localStorage;
}
export function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(storageFor(key).getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function write(key: string, value: unknown) {
  try {
    storageFor(key).setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing may disallow storage. */
  }
}
export function randomName() {
  const a = [
    "慢悠悠的",
    "爱摸牌的",
    "不服输的",
    "眯着眼的",
    "幸运的",
    "会发光的",
    "晒太阳的",
    "认真出牌的",
  ];
  const b = ["橘子", "河豚", "栗子", "熊猫", "小鹿", "海獭", "饭团", "蘑菇"];
  const numbers = crypto.getRandomValues(new Uint32Array(2));
  return a[numbers[0] % a.length] + b[numbers[1] % b.length];
}
export function randomSeed() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // LAN development over HTTP may not expose randomUUID; getRandomValues still works.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
