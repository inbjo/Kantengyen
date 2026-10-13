import { useEffect, useRef } from "react";
import type { Snapshot } from "./types";
import { announceSequence, stopAnnouncement } from "./speech";

function playKey(table: Snapshot) {
  const play = table.last;
  return play ? `${table.round}:${play.seat}:${play.pattern.kind}:${play.pattern.rank}:${play.cards.join(",")}` : "";
}

function ownTurn(table: Snapshot) {
  const player = table.players[table.seat];
  return table.phase === "playing" && table.turn === table.seat && !player?.managed && !player?.auto_play && !player?.pending && !table.auto_pass_available;
}

function eventClips(previous: Snapshot, table: Snapshot) {
  const clips: string[] = [];
  if (table.phase === "playing" && (previous.phase !== "playing" || previous.round !== table.round)) {
    clips.push(table.round === 1 ? "game_start" : "again");
  } else if (previous.phase === "playing" && (table.phase === "playing" || table.phase === "finished")) {
    if (table.last && playKey(table) !== playKey(previous)) {
      const { pattern, seat } = table.last;
      clips.push(pattern.kind === "single" || pattern.kind === "pair" ? `${pattern.kind}-${pattern.rank}` : pattern.kind);
      if (table.phase === "playing" && table.players[seat]?.count === 1 && previous.players[seat]?.count !== 1) clips.push("one_left");
    } else if (previous.last && previous.turn !== table.turn && table.phase === "playing") {
      // A confirmed turn advance without a new play is a pass, including the
      // final pass that clears the trick. All passes share the same voice pool.
      const passClips = ["pass", "cannot_play", "decline"];
      clips.push(passClips[Math.floor(Math.random() * passClips.length)]);
    }
  }
  if (table.phase === "finished" && previous.phase !== "finished") {
    clips.push("round_end");
    if (table.winner === table.seat) clips.push("you_win");
  }
  if (ownTurn(table) && (!ownTurn(previous) || previous.round !== table.round)) clips.push("your_turn");
  return clips;
}

export function useGameAnnouncements(table: Snapshot | null, status: string, enabled: boolean, room: string, now: number) {
  const previous = useRef<Snapshot | null>(null);
  const connection = useRef("");
  const reminder = useRef<{ turn: string; stage: number }>({ turn: "", stage: 0 });
  useEffect(() => {
    previous.current = null;
    reminder.current = { turn: "", stage: 0 };
    stopAnnouncement();
  }, [room]);
  useEffect(() => {
    const connected = status === "online";
    if (!connected) {
      previous.current = null;
      connection.current = status;
      stopAnnouncement();
      return;
    }
    if (!table) return;
    const before = previous.current;
    previous.current = table;
    const reconnected = connection.current !== "online";
    connection.current = status;
    // Initial/reconnected snapshots and toggling speech never replay old events.
    if (!enabled || reconnected || !before || before.code !== table.code || before.version >= table.version) return;
    const clips = eventClips(before, table);
    if (clips.length) announceSequence(clips);
  }, [table, status, enabled]);
  useEffect(() => {
    if (!table || status !== "online" || !ownTurn(table) || !table.deadline_ms || table.practice) return;
    const turn = `${room}:${table.round}:${table.turn}:${table.deadline_ms}`;
    const seconds = Math.ceil((table.deadline_ms - now) / 1000);
    if (reminder.current.turn !== turn) {
      // Reentry near the deadline does not immediately fire a stale reminder.
      reminder.current = { turn, stage: seconds <= 5 ? 1 : 0 };
      return;
    }
    const stage = seconds <= 5 ? 1 : 0;
    if (stage <= reminder.current.stage || seconds <= 0) return;
    reminder.current.stage = stage;
    if (enabled && !table.auto_pass_available) announceSequence(["time_warning"]);
  }, [table, status, enabled, room, now]);
}
