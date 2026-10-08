import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types";
import { randomSeed } from "./storage";

export function useRoom(
  code: string,
  token: string,
  notify: (message: string) => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<"connecting" | "online" | "offline" | "closed">(
    "connecting",
  );
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<number[] | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const ws = useRef<WebSocket | null>(null);
  const current = useRef<Snapshot | null>(null);
  const notifyRef = useRef(notify);
  const pending = useRef(false);
  const pendingReady = useRef<{ action: string; request_id: string; attempts: number } | null>(null);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  useEffect(() => {
    setSnapshot(null);
    current.current = null;
    setHint(null);
    setConnectionError("");
    pendingReady.current = null;
    if (!code || !token) return;
    let cancelled = false;
    let fatal = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const readinessRetry = setInterval(() => {
      const intent = pendingReady.current;
      if (!intent || ws.current?.readyState !== WebSocket.OPEN || !current.current) return;
      if (intent.attempts >= 3) {
        pendingReady.current = null; pending.current = false; setBusy(false);
        notifyRef.current("准备状态未确认，请检查连接后重试"); return;
      }
      intent.attempts++;
      ws.current.send(JSON.stringify({ ...intent, version: current.current.version, cards: [] }));
    }, 1200);
    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
      );
      ws.current = socket;
      let lastMessage = Date.now();
      socket.onopen = () => {
        socket.send(JSON.stringify({ code, token }));
        attempts = 0;
        heartbeat = setInterval(() => {
          if (Date.now() - lastMessage > 45_000) {
            socket.close();
            return;
          }
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                action: "ping",
                version: 0,
                request_id: randomSeed(),
              }),
            );
        }, 20_000);
      };
      socket.onmessage = (event) => {
        lastMessage = Date.now();
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "snapshot") {
          current.current = message;
          setSnapshot(message);
          setStatus("online");
          const intent = pendingReady.current;
          const confirmed = !intent || message.players[message.seat]?.ready === (intent.action === "ready_on");
          if (confirmed) pendingReady.current = null;
          pending.current = !confirmed;
          setBusy(!confirmed);
          setHint(null);
          if (message.phase === "ended") {
            fatal = true;
            setStatus("closed");
            socket.close();
          }
        } else if (message.type === "hint") {
          if (message.version === current.current?.version)
            setHint(message.cards);
          pending.current = false;
          setBusy(false);
        } else if (message.type === "error" || message.type === "fatal") {
          if (pendingReady.current && message.type === "error" && message.error === "牌桌状态已更新，请重新操作") return;
          pendingReady.current = null;
          notifyRef.current(message.error);
          pending.current = false;
          setBusy(false);
          if (message.type === "fatal") {
            fatal = true;
            setConnectionError(message.error);
            setStatus("closed");
            socket.close();
          }
        }
      };
      socket.onclose = () => {
        clearInterval(heartbeat);
        pending.current = false;
        setBusy(false);
        if (cancelled) return;
        setStatus(fatal ? "closed" : "offline");
        if (!fatal)
          retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 8000));
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      clearInterval(readinessRetry);
      ws.current?.close();
    };
  }, [code, token]);
  const send = useCallback((action: string, cards: number[] = []) => {
    if (
      ws.current?.readyState !== WebSocket.OPEN ||
      !current.current ||
      pending.current
    )
      return;
    pending.current = true;
    setBusy(true);
    const requestId = randomSeed();
    if (action === "ready") {
      action = current.current.players[current.current.seat].ready ? "ready_off" : "ready_on";
      pendingReady.current = { action, request_id: requestId, attempts: 0 };
    }
    ws.current.send(
      JSON.stringify({
        action,
        cards,
        version: current.current.version,
        request_id: requestId,
      }),
    );
  }, []);
  return { snapshot, status, connectionError, busy, hint, send };
}
