export interface Profile {
  id: string;
  name: string;
  avatar_seed: string;
}
export interface Session {
  token: string;
  profile: Profile;
}
export interface Player extends Profile {
  bot: boolean;
  ready: boolean;
  online: boolean;
  auto_play?: boolean;
  managed?: boolean;
  score: number;
  count: number;
}
export interface Pattern {
  kind: "single" | "pair" | "straight" | "bomb" | "deep_bomb";
  rank: number;
  len: number;
}
export interface Snapshot {
  type: "snapshot";
  code: string;
  practice: boolean;
  host: string;
  seat: number;
  round: number;
  version: number;
  phase: "waiting" | "playing" | "finished" | "ended";
  completed_rounds: number;
  round_limit: number | null;
  abandoned_round: boolean;
  final_scores: { id: string; name: string; avatar_seed: string; score: number; rank: number }[];
  deadline_ms: number;
  players: Player[];
  hand: number[] | null;
  turn: number | null;
  last: { seat: number; cards: number[]; pattern: Pattern } | null;
  auto_pass_available: boolean;
  deck_count: number;
  multiplier: number;
  winner: number | null;
  result: number[] | null;
  message: string;
  history: string[];
  settlement?: { round: number; multiplier: number; winner: number | null;
    entries: { id: string; name: string; remaining: number; delta: number; contribution: number }[] } | null;
}
