import type { Pattern } from "./types";
type Rules = {
  check_play: (
    low: number,
    high: number,
    kind: number,
    rank: number,
    len: number,
  ) => number;
};
let rules: Rules | null = null;
export async function loadRules() {
  const response = await fetch("/rules.wasm");
  if (!response.ok) throw new Error("WASM 未生成");
  const { instance } = await WebAssembly.instantiate(
    await response.arrayBuffer(),
  );
  rules = instance.exports as unknown as Rules;
}
export function inspectSelection(
  cards: number[],
  previous: Pattern | null,
): string | null {
  if (!rules || !cards.length) return null;
  let low = 0;
  let high = 0;
  for (const c of cards) {
    if (c < 32) low |= 1 << c;
    else high |= 1 << (c - 32);
  }
  const kinds = { single: 1, pair: 2, straight: 3, bomb: 4, deep_bomb: 5 };
  const code = rules.check_play(
    low >>> 0,
    high >>> 0,
    previous ? kinds[previous.kind] : 0,
    previous?.rank ?? 0,
    previous?.len ?? 0,
  );
  if (!code) return "这组牌暂时不能出，试试提示";
  return ["", "单张", "对子", "顺子", "炸弹", "深水炸弹"][
    Math.floor(code / 65536)
  ];
}
