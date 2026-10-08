import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import multiavatar from "@multiavatar/multiavatar/esm";
import {
  ArrowRight,
  Download,
  Check,
  Bomb,
  Crown,
  Layers,
  Zap,
  Copy,
  Share2,
  Dice5,
  DoorOpen,
  Expand,
  GraduationCap,
  HelpCircle,
  Lightbulb,
  LoaderCircle,
  Plus,
  RotateCw,
  Settings2,
  Shuffle,
  Spade,
  Users,
  WifiOff,
  Volume2,
  VolumeX,
  Mic,
  MicOff,
  X,
} from "lucide-react";
import type { Profile, Session, Player } from "./types";
import { randomName, randomSeed, read, write } from "./storage";
import { useRoom } from "./useRoom";
import { useVoice } from "./useVoice";
import { useScreenWakeLock } from "./useScreenWakeLock";
import { usePwa } from "./usePwa";
import { useCardSelection } from "./useCardSelection";
import { loadRules, inspectSelection } from "./rules";
import { unlockAudio, playCardSound } from "./audio";
import { announceCard, stopAnnouncement, unlockSpeech } from "./speech";
import { JokerArt } from "./JokerArt";
import "./style.css";

const lessons = [
  {
    title: "只大一级，才接得上",
    text: "上家出 3，你只能接 4；出一对 6，只能接一对 7。没有合适的牌就点“过牌”。2 是例外，可以接任意较小的单张或对子。",
    tip: "先试着选一张 3，再点出牌。点“提示”可以找到一种合法出法。",
  },
  {
    title: "连起来，就是顺子",
    text: "至少三张连续点数组成顺子，例如 3、4、5。接牌必须长度相同、起点大一级：345 只能由 456 接上。A 可以在末尾，2 不参与顺子。",
    tip: "你的起手有 3、4、5，可以一起选中。无人接牌时，你会摸一张，再自由领出。",
  },
  {
    title: "炸弹与万能牌",
    text: "三张同点数是炸弹，四张是深水炸弹，可以压普通牌型。小王和大王是万能牌，可以补成对子、顺子或炸弹，但不能单出，也不能单独组成牌型。",
    tip: "试试三个 6 的炸弹，或者用万能牌补成对子。最先出完手牌的人获胜。",
  },
];
const patternNames = {
  single: "单张",
  pair: "对子",
  straight: "顺子",
  bomb: "炸弹",
  deep_bomb: "深水炸弹",
};
function Avatar({
  seed,
  name,
  className = "",
}: {
  seed: string;
  name: string;
  className?: string;
}) {
  const src = useMemo(
    () =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(multiavatar(seed))}`,
    [seed],
  );
  return (
    <img className={`avatar ${className}`} src={src} alt={`${name}的头像`} />
  );
}
function Card({
  card,
  selected = false,
  onClick,
  small = false,
}: {
  card: number;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  const wild = card >= 52;
  const rank = (card % 13) + 3;
  const label = wild
    ? card === 52 ? "小" : "大"
    : ({ 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" }[rank] ?? String(rank));
  const suit = wild ? "王" : ["♠", "♥", "♣", "♦"][Math.floor(card / 13)];
  const description = wild
    ? `${card === 52 ? '小王' : '大王'}（万能牌）`
    : `${["黑桃", "红桃", "梅花", "方块"][Math.floor(card / 13)]}${label}`;
  const content = (
    <>
      <span className={`card-corner ${wild ? "joker-corner" : ""}`}>
        {label}
        <small>{suit}</small>
      </span>
      {wild ? <><span className="joker-lettering">JOKER</span><JokerArt color={card === 53} /></> : <span className="card-center">{suit}</span>}
      <span className="card-bottom">{label}</span>
      {wild && <span className="wild-label">万能牌</span>}
    </>
  );
  const classes = `playing-card ${card === 53 || [1, 3].includes(Math.floor(card / 13)) ? "red" : ""} ${wild ? "wild" : ""} ${selected ? "selected" : ""} ${small ? "small" : ""}`;
  return onClick ? (
    <button
      className={classes}
      aria-label={description}
      aria-pressed={selected}
      data-card={card}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={classes} role="img" aria-label={description}>
      {content}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
  feedback,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  feedback?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      aria-label={title}
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {feedback && <p className="modal-feedback" role="alert">{feedback}</p>}
      {children}
    </dialog>
  );
}

function App() {
  const pwa = usePwa();
  const saved = useMemo(
    () => read<Session | null>("kantengyen.session", null),
    [],
  );
  const [profile, setProfile] = useState<Profile>(
    () =>
      saved?.profile ?? {
        id: "",
        name: randomName(),
        avatar_seed: randomSeed(),
      },
  );
  const [session, setSession] = useState<Session | null>(saved);
  const [initialRoom] = useState(() => {
    const code = new URLSearchParams(location.search).get("room") ?? "";
    return /^[1-9]\d{3}$/.test(code) ? code : "";
  });
  const [room, setRoom] = useState(() =>
    saved?.token && initialRoom === read("kantengyen.room", "") ? initialRoom : "",
  );
  const [roomInput, setRoomInput] = useState(
    () => initialRoom,
  );
  const [dialog, setDialog] = useState<
    "welcome" | "create" | "join" | "profile" | "rules" | "leave" | "end" | "orientation" | "install" | null
  >(() =>
    room
      ? null
      : roomInput
      ? "join"
      : read("kantengyen.intro_seen", false)
        ? null
        : "welcome",
  );
  const [loading, setLoading] = useState(false);
  const [roundChoice, setRoundChoice] = useState("8");
  const [botCount, setBotCount] = useState(0);
  const [playOrder, setPlayOrder] = useState<"random" | "winner">("random");
  const [customRounds, setCustomRounds] = useState("8");
  const [toast, setToast] = useState("");
  const [inviteInfo, setInviteInfo] = useState<{ count: number; round_limit: number | null; available: boolean; reason: string } | null>(null);
  const [inviteError, setInviteError] = useState("");
  useEffect(() => {
    if (dialog === "welcome") write("kantengyen.intro_seen", true);
  }, [dialog]);
  const [playEffect, setPlayEffect] = useState<{ key: string; kind: string; label: string } | null>(null);
  const previousPlay = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<number[]>([]);
  const [lessonOpen, setLessonOpen] = useState(() => read("kantengyen.lesson_open", true));
  const [showLog, setShowLog] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [autoPass, setAutoPass] = useState(() => read("kantengyen.auto_pass", true));
  const [soundEnabled, setSoundEnabled] = useState(() => read("kantengyen.sound_enabled", true));
  const [speechEnabled, setSpeechEnabled] = useState(() => read("kantengyen.speech_enabled", true));
  const [keepScreenOn, setKeepScreenOn] = useState(() => read("kantengyen.keep_screen_on", true));
  const [now, setNow] = useState(Date.now());
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const notify = useCallback((text: string) => setToast(text), []);
  const previousRoom = useRef(room);
  useEffect(() => {
    if (room || previousRoom.current) {
      const url = new URL(location.href);
      if (room) url.searchParams.set("room", room);
      else url.searchParams.delete("room");
      history.replaceState(history.state, "", url);
    }
    previousRoom.current = room;
  }, [room]);
  const {
    snapshot: table,
    status,
    connectionError,
    busy,
    hint,
    send,
  } = useRoom(room, session?.token ?? "", notify);
  const selectionGesture = useCardSelection(table?.hand ?? [], selected, setSelected, table?.version ?? 0);
  const myManaged = !table?.practice && !!table?.players[table.seat]?.managed;
  const waitingNext = !!table?.players[table.seat]?.pending;
  useEffect(() => {
    setInviteInfo(null); setInviteError("");
    if (dialog !== "join" || !/^[1-9]\d{3}$/.test(roomInput) || !pwa.online) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/rooms/${roomInput}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "无法查询房间");
        setInviteInfo(data);
      } catch (error) { if (!controller.signal.aborted) setInviteError(error instanceof Error ? error.message : "无法查询房间，请稍后重试"); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [dialog, roomInput, pwa.online]);
  const orientationChecked = useRef("");
  useEffect(() => {
    if (!room) { orientationChecked.current = ""; return; }
    if (!table) return;
    if (table.phase === "ended") {
      setDialog(current => current === "orientation" ? null : current);
      return;
    }
    if (orientationChecked.current === room) return;
    orientationChecked.current = room;
    if (window.matchMedia("(orientation: portrait)").matches) setDialog("orientation");
  }, [room, table?.code, table?.phase]);
  useEffect(() => {
    if (dialog !== "orientation") return;
    const portrait = window.matchMedia("(orientation: portrait)");
    const changed = () => { if (!portrait.matches) setDialog(null); };
    portrait.addEventListener("change", changed);
    return () => portrait.removeEventListener("change", changed);
  }, [dialog]);
  const screenWakeLock = useScreenWakeLock(keepScreenOn && !!room && !!table && table.phase !== "ended");
  const voiceAllowed = !!table && !table.practice && table.phase !== "ended" && status === "online";
  const voice = useVoice(room, session?.token ?? "", voiceAllowed, notify);
  useEffect(() => { if (!voiceAllowed) setShowVoice(false); }, [voiceAllowed]);
  const playKey = table?.last
    ? `${room}:${table.round}:${table.last.seat}:${table.last.pattern.kind}:${table.last.pattern.rank}:${table.last.cards.join(",")}`
    : `${room}:${table?.round ?? 0}:lead`;
  useEffect(() => {
    previousPlay.current = undefined;
    setPlayEffect(null);
  }, [room]);
  useEffect(() => {
    if (!speechEnabled) { stopAnnouncement(); return; }
    const hidden = () => { if (document.hidden) stopAnnouncement(); };
    document.addEventListener("pointerdown", unlockSpeech);
    document.addEventListener("keydown", unlockSpeech);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("pointerdown", unlockSpeech);
      document.removeEventListener("keydown", unlockSpeech);
      document.removeEventListener("visibilitychange", hidden);
      stopAnnouncement();
    };
  }, [speechEnabled, room]);
  useEffect(() => {
    if (status !== "online") { previousPlay.current = undefined; stopAnnouncement(); return; }
    if (!table) return;
    if (table.phase === "ended" || table.phase === "waiting") stopAnnouncement();
    const previous = previousPlay.current;
    previousPlay.current = playKey;
    if (previous === undefined || previous === playKey) return;
    setPlayEffect(null);
    if (!table.last || (table.phase !== "playing" && table.phase !== "finished")) return;
    const pattern = table.last.pattern;
    const kind = (pattern.kind === "single" || pattern.kind === "pair") && pattern.rank === 15 ? "two" : pattern.kind;
    if (soundEnabled) playCardSound(table.phase === "finished" ? "win" : kind);
    if (speechEnabled) announceCard(pattern);
    if (table.phase !== "playing") return;
    if (kind === "single") return;
    setPlayEffect({ key: playKey, kind, label: kind === "two" ? "2 · 强势接牌" : patternNames[pattern.kind] });
  }, [playKey, table?.phase, soundEnabled, speechEnabled, status]);
  useEffect(() => {
    if (!soundEnabled) return;
    document.addEventListener("pointerdown", unlockAudio);
    document.addEventListener("keydown", unlockAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockAudio);
      document.removeEventListener("keydown", unlockAudio);
    };
  }, [soundEnabled]);
  useEffect(() => {
    if (!playEffect) return;
    const timer = setTimeout(() => setPlayEffect(null), 1300);
    return () => clearTimeout(timer);
  }, [playEffect]);
  useEffect(() => {
    loadRules()
      .then(() => setRulesLoaded(true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    if (dialog) return; // Keep form errors visible until edited or the dialog is closed.
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast, dialog]);
  useEffect(() => { setToast(""); }, [dialog]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setSelected([]);
  }, [table?.version]);
  useEffect(() => {
    if (hint !== null) {
      setSelected(hint);
      if (!hint.length) notify("没有可以接上的牌，可以过牌");
    }
  }, [hint, notify]);

  async function api(path: string, body: unknown, token = session?.token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "请求失败");
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function ensureSession() {
    const next: Session = await api("/api/session", {
      token: session?.token,
      name: profile.name.trim(),
      avatar_seed: profile.avatar_seed,
    });
    setSession(next);
    setProfile(next.profile);
    write("kantengyen.session", next);
    if (session && next.token !== session.token) write("kantengyen.room", "");
    return next;
  }
  async function enter(mode: "practice" | "create" | "join" | "resume") {
    if (loading) return;
    if (!pwa.online) { notify("当前没有网络，请联网后再入座"); return; }
    const roundLimit = roundChoice === "unlimited" ? null : Number(roundChoice === "custom" ? customRounds : roundChoice);
    if (mode === "create" && roundLimit !== null && (!Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > 4294967295)) {
      notify("请输入有效的正整数局数");
      return;
    }
    if (mode === "join" && !/^[1-9]\d{3}$/.test(roomInput)) {
      notify("请输入 1000–9999 的四位房间号");
      return;
    }
    setLoading(true);
    try {
      const next = await ensureSession();
      const result =
        mode === "create" || mode === "practice"
          ? await api(
              "/api/rooms",
              { practice: mode === "practice", round_limit: roundLimit,
                bot_count: mode === "practice" ? 0 : botCount, play_order: playOrder },
              next.token,
            )
          : await api(
              `/api/rooms/${mode === "resume" ? read("kantengyen.room", "") : roomInput}/join`,
              {},
              next.token,
            );
      setRoom(result.code);
      setDialog(null);
      write("kantengyen.room", result.code);
      write("kantengyen.intro_seen", true);
    } catch (e) {
      notify(e instanceof Error ? e.message : "无法连接服务器，请稍后再试");
    } finally {
      setLoading(false);
    }
  }
  async function leave() {
    if (table?.phase === "ended") {
      setRoom("");
      setDialog(null);
      write("kantengyen.room", "");
      return;
    }
    setLoading(true);
    try {
      const result = await api(`/api/rooms/${room}/leave`, {});
      setRoom("");
      setDialog(null);
      write("kantengyen.room", result.seat_retained ? room : "");
      if (result.seat_retained) notify("已暂时离桌，座位和累计分数保留，可返回原房间");
    } catch (e) {
      notify(e instanceof Error ? e.message : "退出失败");
    } finally {
      setLoading(false);
    }
  }
  function skipIntro() {
    write("kantengyen.intro_seen", true);
    setDialog(null);
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/?room=${room}`);
      notify("邀请链接已复制，发给朋友就能入座");
    } catch {
      notify(`房间号是 ${room}，可以直接告诉朋友`);
    }
  }
  async function shareInvite() {
    if (!navigator.share) { await copyInvite(); return; }
    try {
      await navigator.share({ title: `干瞪眼 · 房间 ${room}`,
        text: `房间 ${room} · ${table?.players.length ?? 1}/8 人 · ${table?.round_limit ? `${table.round_limit} 局` : "血战到底"}，一起玩干瞪眼！`,
        url: `${location.origin}/?room=${room}` });
    } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) await copyInvite(); }
  }
  function returnFromInvite() {
    const url = new URL(location.href); url.searchParams.delete("room"); history.replaceState(history.state,"",url);
    setRoomInput(""); setDialog(null); setToast("");
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      notify("当前浏览器不支持全屏，可以横置手机继续游玩");
    }
  }
  const myTurn = table?.phase === "playing" && table.turn === table.seat && !myManaged && !waitingNext;
  useEffect(() => {
    if (!autoPass || !table?.auto_pass_available || status !== "online" || busy) return;
    // A short pause makes the skipped turn legible, and allows opting out.
    const timer = setTimeout(() => {
      send("auto_pass");
      notify("要不起，已自动过牌");
    }, 2000);
    return () => clearTimeout(timer);
  }, [autoPass, table?.version, table?.auto_pass_available, status, busy, send, notify]);
  useEffect(() => {
    if (table?.phase === "ended") {
      write("kantengyen.room", "");
      const url = new URL(location.href);
      url.searchParams.delete("room");
      history.replaceState(history.state, "", url);
    }
  }, [table?.phase]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        dialog ||
        !myTurn ||
        ["INPUT", "TEXTAREA", "BUTTON"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;
      if (e.key.toLowerCase() === "h") send("hint");
      if (e.key.toLowerCase() === "p" && table?.last) send("pass");
      if (e.key === "Enter" && selected.length) send("play", selected);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dialog, myTurn, table?.last, selected, send]);
  const lesson = lessons[((table?.round ?? 1) - 1) % 3];
  const seconds = Math.max(
    0,
    Math.ceil(((table?.deadline_ms ?? 0) - now) / 1000),
  );
  const selectionLabel = rulesLoaded
    ? inspectSelection(selected, table?.last?.pattern ?? null)
    : null;
  const resume = read<string>("kantengyen.room", "");

  return (
    <div className={`app ${room ? "in-room" : ""}`}>
      <header className="topbar">
        <button
          className="brand"
          onClick={() => (room ? setDialog("leave") : setDialog(null))}
          aria-label={room ? "离开房间" : "首页"}
        >
          <span className="brand-seal">
            <Spade size={23} fill="currentColor" />
          </span>
          <span>
            <b>干瞪眼</b>
            <small>再 来 一 把</small>
          </span>
        </button>
        <div className="topbar-middle">
          {room ? (
            <>
              <span className="connection">
                <i className={status} />
                {table?.phase === "ended" ? "房间已解散" : status === "online"
                  ? "已连接"
                  : status === "connecting"
                    ? "连接中"
                    : status === "closed" ? "连接已结束" : "正在重连"}
              </span>
              <span className="room-label">
                {table?.practice ? (
                  "新手练习"
                ) : (
                  <>
                    房间 <strong>{room}</strong>
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="edition">朋友围坐 · 好牌慢打</span>
          )}
        </div>
        <nav className="toolbar">
          <button className="icon-button" aria-label={soundEnabled ? "关闭音效" : "开启音效"} aria-pressed={soundEnabled} onClick={() => {
            const enabled = !soundEnabled;
            setSoundEnabled(enabled);
            write("kantengyen.sound_enabled", enabled);
            if (enabled) unlockAudio();
          }}>
            {soundEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
          {table && !table.practice && table.phase !== "ended" && table.host === table.players[table.seat].id && (
            <button className="end-game-button" disabled={busy || status !== "online"} onClick={() => setDialog("end")}>
              结束游戏
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => setDialog("rules")}
            aria-label="游戏规则"
          >
            <HelpCircle size={21} />
          </button>
          <button
            className="icon-button"
            onClick={fullscreen}
            aria-label="切换全屏"
          >
            <Expand size={20} />
          </button>
          {room && (
            <button
              className="icon-button"
              onClick={() => setDialog("leave")}
              aria-label="退出房间"
            >
              <DoorOpen size={20} />
            </button>
          )}
          {!room && (
            <button
              className="profile-button"
              onClick={() => setDialog("profile")}
            >
              <Avatar seed={profile.avatar_seed} name={profile.name} />
              <span>{profile.name}</span>
              <Settings2 size={15} />
            </button>
          )}
        </nav>
      </header>

      {!pwa.online && <div className="pwa-notice" role="status">当前没有网络 · 页面仍可查看，练习和联机对局需要联网</div>}

      {!room ? (
        <main className="lobby">
          <section className="lobby-intro">
            <div className="eyebrow">
              <span /> 一副牌，一桌朋友
            </div>
            <h1>
              好牌不怕等，
              <br />
              就怕你<span>干瞪眼。</span>
            </h1>
            <p className="intro-copy">
              差一张，接不上。摸一张，翻个盘。
              <br />
              不用下载，叫上朋友就开桌。
            </p>
            <div className="hero-cards" aria-hidden="true">
              <Card card={0} />
              <Card card={14} />
              <Card card={28} />
              <span className="handwritten">只大一级，才接得上 ↗</span>
            </div>
            <div className="lobby-footnote">
              <span>2–8 人同桌</span>
              <i /> <span>和朋友围坐一桌</span>
            </div>
          </section>
          <section className="lobby-actions">
            <div className="identity-summary">
              <Avatar seed={profile.avatar_seed} name={profile.name} />
              <div>
                <small>今天以这个身份入座</small>
                <strong>{profile.name}</strong>
              </div>
              <button
                className="icon-button"
                onClick={() => setDialog("profile")}
                aria-label="修改名字与头像"
              >
                <Shuffle size={20} />
              </button>
            </div>
            <button
              className="entry practice-entry"
              disabled={loading}
              onClick={() => enter("practice")}
            >
              <span className="entry-icon">
                <GraduationCap size={26} />
              </span>
              <span>
                <strong>先练三把</strong>
                <small>两位机器人陪你，从零学会干瞪眼</small>
              </span>
              <ArrowRight size={20} />
            </button>
            <button
              className="entry create-entry"
              disabled={loading}
              onClick={() => setDialog("create")}
            >
              <span className="entry-icon">
                <Plus size={27} />
              </span>
              <span>
                <strong>创建房间</strong>
                <small>你来开桌，邀请朋友入座</small>
              </span>
              <ArrowRight size={20} />
            </button>
            <button
              className="entry join-entry"
              disabled={loading}
              onClick={() => setDialog("join")}
            >
              <span className="entry-icon">
                <Users size={25} />
              </span>
              <span>
                <strong>加入房间</strong>
                <small>输入四位房间号，马上见面</small>
              </span>
              <ArrowRight size={20} />
            </button>
            {resume && (
              <button
                className="resume-button"
                disabled={loading}
                onClick={() => enter("resume")}
              >
                <RotateCw size={15} /> 返回上次的房间 {resume}
              </button>
            )}
            {loading && (
              <p className="loading-text">
                <LoaderCircle className="spin" size={16} /> 正在为你安排座位…
              </p>
            )}
            <p className="avatar-credit">只记积分，轻松玩牌</p>
            {!pwa.installed && <button className="text-button pwa-install" onClick={async () => {
              if (!await pwa.install()) setDialog("install");
            }}><Download size={16} /> 安装到桌面</button>}
            {pwa.updateAvailable && <button className="secondary pwa-update" disabled={!pwa.online} onClick={pwa.refresh}>
              <RotateCw size={16} /> 新版本已就绪，刷新更新
            </button>}
          </section>
        </main>
      ) : !table ? (
        <main className="connecting-screen">
          {status !== "closed" && <LoaderCircle size={36} className="spin" />}
          <h2>{status === "closed" ? "连接已结束" : "正在入座"}</h2>
          <p>{status === "closed" ? connectionError : `连接房间 ${room}，请稍等`}</p>
          <button
            className="secondary"
            onClick={() => {
              if (status === "closed") write("kantengyen.room", "");
              setRoom("");
              setDialog(null);
            }}
          >
            返回首页
          </button>
        </main>
      ) : (
        <main className={`game-area ${table.players.length >= 7 ? "large-table" : ""}`}>
          <div className="table-meta">
            <span>
              {table.practice
                ? `练习 ${Math.min(table.round, 3)} / 3`
                : `第 ${table.round || 1} 局${table.round_limit ? ` / ${table.round_limit}` : " · 血战到底"}`}
            </span>
            <span>
              {table.practice ? '练习牌堆' : '牌堆'} <b>{table.deck_count}</b>
            </span>
            <span>
              倍率 <b>×{table.multiplier}</b>
            </span>
            <button onClick={() => setShowLog(!showLog)}>牌局记录</button>
            {!table.practice && table.phase === "playing" && !waitingNext && <div className="managed-control">
              {myManaged && <span>机器正在代打</span>}
              <button disabled={busy || status !== "online"} onClick={() => send(myManaged ? "resume" : "takeover")}>
                {myManaged ? "恢复自己出牌" : "开启托管"}
              </button>
            </div>}
            <button disabled={!screenWakeLock.supported}
              aria-label={keepScreenOn ? "关闭屏幕常亮" : "开启屏幕常亮"}
              aria-pressed={keepScreenOn}
              title={!screenWakeLock.supported ? "当前浏览器不支持屏幕常亮" : screenWakeLock.active ? "屏幕常亮已生效，点击关闭" : keepScreenOn ? "已请求常亮，浏览器尚未允许；切回网页或点击后会重试" : "点击开启屏幕常亮"}
              onClick={() => {
                const enabled = !keepScreenOn;
                setKeepScreenOn(enabled);
                write("kantengyen.keep_screen_on", enabled);
              }}>
              {!screenWakeLock.supported ? "常亮不支持" : screenWakeLock.active ? "常亮开" : keepScreenOn ? "常亮待开启" : "常亮关"}
            </button>
            <button className="speech-entry" aria-label={speechEnabled ? "关闭出牌播报" : "开启出牌播报"} aria-pressed={speechEnabled} title="使用设备中文声音播报；无中文声音时保留普通音效" onClick={() => {
              const enabled = !speechEnabled;
              setSpeechEnabled(enabled);
              write("kantengyen.speech_enabled", enabled);
              if (enabled) unlockSpeech(); else stopAnnouncement();
            }}>播报{speechEnabled ? "开" : "关"}</button>
            {voiceAllowed && <button className={`voice-entry ${voice.status === "online" ? "active" : ""}`} aria-label="房间语音" aria-expanded={showVoice} onClick={() => setShowVoice(!showVoice)}>
              {voice.muted ? <MicOff size={13} /> : <Mic size={13} />} {voice.status === "off" ? "语音" : voice.status === "starting" ? "语音连接中" : `语音已开启 · ${voice.members.length + 1}人`}
            </button>}
          </div>
          {showVoice && voiceAllowed && <aside className="voice-panel" aria-label="房间语音控制">
            <div className="voice-heading"><strong>这一桌，聊着玩</strong><button className="icon-button" aria-label="收起语音面板" onClick={() => setShowVoice(false)}><X size={16} /></button></div>
            {voice.status === "off" ? <>
              <p>只与本房间主动开启语音的玩家通话。开启后会申请麦克风权限。</p>
              <button className="primary" onClick={voice.start}><Mic size={15} /> 开启房间语音</button>
            </> : <>
              <p className="voice-state">{voice.status === "starting" ? "正在申请麦克风并连接…" : voice.muted ? "麦克风已静音" : "麦克风已开启"}</p>
              {voice.status === "online" && <div className="voice-controls">
                <button className="secondary" aria-pressed={voice.muted} onClick={voice.toggleMuted}>{voice.muted ? <MicOff size={15} /> : <Mic size={15} />}{voice.muted ? "取消麦克风静音" : "麦克风静音"}</button>
                <button className="secondary" aria-pressed={voice.speakerMuted} onClick={voice.toggleSpeaker}>{voice.speakerMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}{voice.speakerMuted ? "取消扬声器静音" : "扬声器静音"}</button>
              </div>}
              <div className="voice-members">{voice.members.length ? voice.members.map(member => <div key={member.id} data-peer-id={member.id} data-state={member.connection}>
                {member.muted ? <MicOff size={13} /> : <Mic size={13} />}<span>{member.name}</span><small>{member.connection === "connected" ? member.muted ? "已静音" : "已连接" : member.connection === "failed" ? "连接失败" : "连接中"}</small>
              </div>) : <p>等朋友开启语音</p>}</div>
              {voice.blocked && <button className="secondary" onClick={voice.resumePlayback}>点击恢复语音播放</button>}
              {voice.status === "online" && !voice.hasRelay && <p className="voice-note">未配置 TURN，跨网络连接可能失败。</p>}
              <button className="text-button" onClick={voice.leave}>{voice.status === "starting" ? "取消开启语音" : "退出语音"}</button>
            </>}
          </aside>}
          {waitingNext && table.phase !== "ended" && <p className="queue-notice" role="status">已加入房间 · 等待下一局发牌，当前这局不参与计分</p>}
          <div className="felt-table">
            <div className="felt-inner" />
            <span className="table-watermark">
              干 瞪 眼<small>再 来 一 把</small>
            </span>
          </div>
          {playEffect && table.phase === "playing" && (
            <div key={playEffect.key} className={`play-effect effect-${playEffect.kind}`} aria-hidden="true" data-effect={playEffect.kind}>
              <div className="effect-ring" />
              <div className="effect-ring second" />
              {Array.from({ length: 10 }, (_, i) => <i key={i} className="effect-spark" style={{ "--spark-angle": `${i * 36}deg`, "--spark-delay": `${i * 12}ms` } as React.CSSProperties} />)}
              <div className="effect-title">
                {playEffect.kind === "bomb" || playEffect.kind === "deep_bomb" ? <Bomb size={30} /> : playEffect.kind === "two" ? <Zap size={30} /> : <Layers size={30} />}
                <strong>{playEffect.label}</strong>
              </div>
            </div>
          )}
          {table.players.map((p, index) =>
            index === table.seat ? null : (
              <Seat
                key={p.id}
                player={p}
                index={
                  (index - table.seat + table.players.length) %
                  table.players.length
                }
                count={table.players.length}
                active={table.phase === "playing" && table.turn === index}
                host={p.id === table.host}
              />
            ),
          )}
          {table.phase === "waiting" ? (
            <section className="waiting-center">
              <span className="eyebrow">这一桌，等你们来</span>
              <h2>
                房间 <span>{table.code}</span>
              </h2>
              <p>已入座 {table.players.length} / 8 人 · {table.round_limit ? `${table.round_limit} 局` : "血战到底"} · 至少两人即可开始</p>
              <p className="ready-summary">已准备 {table.players.filter(p => p.ready && p.online).length}/{table.players.length} 人</p>
              {table.players.some(p => !p.ready || !p.online) && <p className="ready-waiting">等待：{table.players.filter(p => !p.ready || !p.online).map(p => `${p.name}${!p.online ? "（离线）" : ""}`).join("、")}</p>}
              <button className="primary invite-button" onClick={shareInvite}><Share2 size={17} /> 一键分享邀请</button>
              <button className="secondary invite-button" onClick={copyInvite}>
                <Copy size={17} /> 复制邀请链接
              </button>
              <div className="empty-chairs">
                {Array.from({ length: 8 - table.players.length }, (_, i) => (
                  <span key={i}>
                    <Plus size={20} />
                    <small>等朋友</small>
                  </span>
                ))}
              </div>
            </section>
          ) : (
            <section className="play-center" aria-live="polite">
              {table.last ? (
                <>
                  <span className="last-player">
                    {table.players[table.last.seat].name} ·{" "}
                    {patternNames[table.last.pattern.kind]}
                  </span>
                  <div className="discard-cards">
                    {table.last.cards.map((c) => (
                      <Card key={c} card={c} small />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <span className="lead-label">自由领出</span>
                  <p>
                    {myTurn
                      ? "轮到你，选好牌就出吧"
                      : `${table.players[table.turn ?? 0].name}正在想牌`}
                  </p>
                </>
              )}
              <p className="game-message">{table.message}</p>
            </section>
          )}
          {showLog && (
            <aside className="game-log">
              <div>
                <strong>牌局记录</strong>
                <button
                  className="icon-button"
                  onClick={() => setShowLog(false)}
                  aria-label="收起记录"
                >
                  <X size={16} />
                </button>
              </div>
              {table.history.length ? (
                table.history.map((text, i) => <p key={i}>{text}</p>)
              ) : (
                <p>还没有出牌记录</p>
              )}
            </aside>
          )}
          {table.practice && table.phase === "playing" && (
            <aside className={`lesson-card ${lessonOpen ? "" : "collapsed"}`}>
              <button
                className="lesson-heading"
                onClick={() => {
                  const open = !lessonOpen;
                  setLessonOpen(open);
                  write("kantengyen.lesson_open", open);
                }}
              >
                <GraduationCap size={18} />
                <span>{lesson.title}</span>
                <small>{lessonOpen ? "收起" : "展开"}</small>
              </button>
              {lessonOpen && (
                <>
                  <p>{lesson.text}</p>
                  <small>{lesson.tip}</small>
                </>
              )}
            </aside>
          )}
          <section className={`hand-zone ${myTurn ? "your-turn" : ""}`}>
            <div className="self-seat">
              <div className="seat-avatar">
                <Avatar seed={profile.avatar_seed} name={profile.name} />
                {table.players[table.seat].id === table.host && <HostBadge />}
              </div>
              <div>
                <strong>{profile.name}</strong>
                <small>
                  累计 {table.players[table.seat].score} 分 ·{" "}
                  {table.players[table.seat].id === table.host ? "房主" : "你"}
                </small>
                <label className="auto-pass-toggle">
                  <input
                    type="checkbox"
                    checked={autoPass}
                    onChange={(e) => {
                      setAutoPass(e.target.checked);
                      write("kantengyen.auto_pass", e.target.checked);
                    }}
                  />
                  要不起过牌
                </label>
              </div>
            </div>
            <div className="hand-container">
              <div className="turn-caption">
                <span>
                  {table.phase === "waiting"
                    ? "朋友准备好，就能开局"
                    : myTurn
                      ? (autoPass && table.auto_pass_available ? "要不起，即将自动过牌" : (selectionLabel ?? "轮到你出牌"))
                      : table.phase === "finished"
                        ? "这一把，打得不错"
                        : "等其他玩家出牌"}
                </span>
                {table.phase === "playing" && !table.practice && (
                  <b>{seconds}s</b>
                )}
              </div>
              <div
                className="hand-cards"
                {...selectionGesture}
                style={
                  {
                    "--card-count": table.hand?.length ?? 0,
                  } as React.CSSProperties
                }
              >
                {table.hand?.map((c) => (
                  <Card
                    key={c}
                    card={c}
                    selected={selected.includes(c)}
                    onClick={() =>
                      setSelected((old) =>
                        old.includes(c)
                          ? old.filter((n) => n !== c)
                          : [...old, c],
                      )
                    }
                  />
                ))}
              </div>
            </div>
            <div className="hand-actions">
              {table.phase === "waiting" ? (
                table.players[table.seat].id === table.host ? (
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      status !== "online" ||
                      table.players.length < 2 ||
                      !table.players.every((p) => p.ready && p.online)
                    }
                    onClick={() => send("start")}
                  >
                    开始游戏 <ArrowRight size={17} />
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || status !== "online"}
                    onClick={() => send("ready")}
                  >
                    {table.players[table.seat].ready
                      ? "取消准备"
                      : "我准备好了"}
                    <Check size={17} />
                  </button>
                )
              ) : (
                <>
                  <div className="action-pair">
                    <button
                      className="secondary"
                      disabled={!myTurn || busy || status !== "online"}
                      onClick={() => send("hint")}
                    >
                      <Lightbulb size={17} /> 提示
                    </button>
                    <button
                      className="secondary"
                      disabled={
                        !myTurn || !table.last || busy || status !== "online"
                      }
                      onClick={() => send("pass")}
                    >
                      过牌
                    </button>
                  </div>
                  <button
                    className="primary play-button"
                    disabled={
                      !myTurn || !selected.length || busy || status !== "online"
                    }
                    onClick={() => send("play", selected)}
                  >
                    出牌 {selected.length > 0 && <span>{selected.length}</span>}
                    <ArrowRight size={17} />
                  </button>
                  <button
                    className="clear-button"
                    onClick={() => setSelected([])}
                    disabled={!selected.length}
                  >
                    重选
                  </button>
                </>
              )}
            </div>
          </section>
          {status !== "online" && table.phase !== "ended" && (
            <div className="connection-banner">
              <WifiOff size={17} /> {status === "closed" ? connectionError : "连接中断，正在恢复牌桌…"}
            </div>
          )}
          <div className="rotate-hint">建议手机用户使用横屏，体验更佳 ↻</div>
          {(table.phase === "finished" || table.phase === "ended") && (
            <div className="result-overlay">
              <section className="result-card">
                <div className="eyebrow">{table.phase === "ended" ? "这一桌，收牌啦" : "这一把结束了"}</div>
                <h2>
                  {table.phase === "ended" ? "总计分" : table.winner === -1
                    ? "握手言和"
                    : table.winner === table.seat
                      ? "好牌，赢了！"
                      : `${table.players[table.winner ?? 0].name}先出完啦`}
                </h2>
                <p>
                  {table.phase === "ended" ? `已完成 ${table.completed_rounds} 局${table.abandoned_round ? " · 未完成的本局不计分" : ""}` : table.practice
                    ? "练习不怕输，学会就算赢。"
                    : `本局得分 · 炸弹倍率 ×${table.multiplier} · 全桌合计 ${(table.result ?? []).reduce((sum, score) => sum + score, 0)} 分`}
                </p>
                <div className="score-list">
                  {table.phase === "ended" ? table.final_scores.map(p => (
                    <div key={p.id}>
                      <small className="score-rank">{p.rank}</small>
                      <Avatar seed={p.avatar_seed} name={p.name} />
                      <span>{p.name}</span>
                      <b className={p.score > 0 ? "positive" : ""}>{p.score > 0 ? "+" : ""}{p.score}</b>
                    </div>
                  )) : table.players.map((p, i) => (
                    <div key={p.id}>
                      <Avatar seed={p.avatar_seed} name={p.name} />
                      <span>{p.name}</span>
                      <small className="cumulative-score">累计 {p.score}</small>
                      <b
                        className={
                          (table.result?.[i] ?? 0) > 0 ? "positive" : ""
                        }
                      >
                        {(table.result?.[i] ?? 0) > 0 ? "+" : ""}
                        {table.result?.[i] ?? 0}
                      </b>
                    </div>
                  ))}
                </div>
                {table.phase !== "ended" && !!table.retired_scores?.length && <div className="retired-scores">
                  <small>已离桌机器人的累计成绩</small>
                  {table.retired_scores.map(p=><p key={p.id}>{p.name} <b>{p.score > 0 ? "+" : ""}{p.score}</b></p>)}
                </div>}
                {table.settlement && <details className="settlement-detail" open>
                  <summary>第 {table.settlement.round} 局计分明细</summary>
                  {table.settlement.entries.map(entry => <p key={entry.id}>
                    <strong>{entry.name}</strong><span>{entry.delta < 0
                      ? `剩余 ${entry.remaining} 张 × ${table.settlement!.multiplier}，扣 ${-entry.delta} 分`
                      : entry.delta > 0 ? `收取 ${table.settlement!.entries.filter(e => e.delta < 0).map(e => `${e.name} ${e.contribution} 分`).join(" + ")} = +${entry.delta} 分`
                        : "本局 0 分"}</span>
                  </p>)}
                </details>}
                {table.phase !== "ended" && table.players[table.seat].id === table.host && (
                  <button
                    className="primary"
                    disabled={busy || status !== "online"}
                    onClick={() => send("next")}
                  >
                    {table.practice && table.round < 3
                      ? "进入下一课"
                      : "再来一把"}
                    <ArrowRight size={17} />
                  </button>
                )}
                {table.phase !== "ended" && table.practice && table.round >= 3 && (
                  <button
                    className="secondary"
                    disabled={loading}
                    onClick={() => {
                      write("kantengyen.practice_done", true);
                      leave();
                    }}
                  >
                    练习完成，去和朋友玩
                  </button>
                )}
                {table.phase !== "ended" && !table.practice &&
                  table.host !== table.players[table.seat].id && (
                    <p className="muted">等房主开启下一局</p>
                  )}
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={leave}
                >
                  返回大厅
                </button>
              </section>
            </div>
          )}
        </main>
      )}

      {dialog === "welcome" && (
        <Modal title="第一把？我们陪你。" close={skipIntro} feedback={toast}>
          <div className="welcome-art" aria-hidden="true">
            <Card card={0} small />
            <Card card={14} small />
            <Card card={28} small />
          </div>
          <p className="modal-copy">
            干瞪眼的乐趣，是“只差一点就接得上”。
            <br />
          先用精选手牌和短牌堆，和阿橘、小满练三把，边打边学。
          </p>
          <div className="welcome-points">
            <span>
              <Check size={16} /> 不懂规则也能玩
            </span>
            <span>
              <Check size={16} /> 随时看提示
            </span>
            <span>
              <Check size={16} /> 没有时间压力
            </span>
          </div>
          <button
            className="primary wide"
            disabled={loading}
            onClick={() => enter("practice")}
          >
            开始新手练习 <ArrowRight size={18} />
          </button>
          <button className="text-button wide" onClick={skipIntro}>
            我会玩了，直接去大厅
          </button>
        </Modal>
      )}
      {dialog === "orientation" && (
        <Modal title="横屏打牌更舒服" close={() => setDialog(null)}>
          <p className="modal-copy">建议手机用户使用横屏，体验更佳。横屏能看清更多手牌，也更方便选牌。转为横屏后此提示会自动关闭。</p>
          <button className="primary wide" onClick={() => setDialog(null)}>知道了，继续玩</button>
        </Modal>
      )}
      {dialog === "install" && (
        <Modal title="把牌桌放到桌面" close={() => setDialog(null)}>
          <p className="modal-copy">下次点桌面上的“干瞪眼”就能开桌，用独立窗口玩牌。安装后仍需联网才能入座。</p>
          <ul className="pwa-instructions">
            <li><strong>iPhone / iPad</strong><span>用 Safari 打开，点分享按钮，选择“添加到主屏幕”。</span></li>
            <li><strong>Android / 电脑</strong><span>用 Chrome 或 Edge 打开，在浏览器菜单中选择“安装应用”或“添加到主屏幕”。</span></li>
            <li><strong>微信内打开</strong><span>先从右上角菜单选择“在浏览器中打开”，再按上面的步骤安装。</span></li>
          </ul>
          <button className="primary wide" onClick={() => setDialog(null)}>知道了</button>
        </Modal>
      )}
      {dialog === "create" && (
        <Modal title="开一桌，玩几局？" close={() => setDialog(null)} feedback={toast}>
          <p className="modal-copy">最多 8 人同桌。打满约定局数后结算总分并解散房间，房主也可提前结束。</p>
          <fieldset className="room-options round-options">
            <legend>对局局数</legend>
            {[["8", "8 局"], ["16", "16 局"], ["20", "20 局"], ["unlimited", "血战到底"], ["custom", "自定义"]].map(([value, label]) => (
              <label key={value} className={roundChoice === value ? "selected" : ""}>
                <input type="radio" name="round-limit" value={value} checked={roundChoice === value} onChange={() => setRoundChoice(value)} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          {roundChoice === "custom" && <label className="custom-rounds">自定义局数
            <input type="number" min="1" max="4294967295" step="1" inputMode="numeric" value={customRounds} onChange={e => setCustomRounds(e.target.value)} />
          </label>}
          {roundChoice === "unlimited" && <p className="modal-copy">不限制局数，玩到房主结束游戏为止。</p>}
          <div className="create-bots">
            <label htmlFor="create-bot-count">机器人数量</label>
            <select id="create-bot-count" value={botCount} onChange={event => setBotCount(Number(event.target.value))}>
              {Array.from({length:8}, (_, count) => <option key={count} value={count}>{count === 0 ? "不添加" : `${count} 个`}</option>)}
            </select>
            <small>真人和机器人合计最多 8 人，创建后不可修改。</small>
          </div>
          <fieldset className="room-options play-order-options">
            <legend>出牌顺序</legend>
            {[["random", "随机"], ["winner", "赢家"]].map(([value, label]) => (
              <label key={value} className={playOrder === value ? "selected" : ""}>
                <input type="radio" name="play-order" value={value} checked={playOrder === value} onChange={() => setPlayOrder(value as "random" | "winner")} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <p className="create-option-note">{playOrder === "random" ? "每局随机一位玩家先出牌。" : "上一局赢家先出牌，首局或流局后随机。"}</p>
          <button className="primary wide" disabled={loading} onClick={() => enter("create")}>确认开桌 <ArrowRight size={18} /></button>
        </Modal>
      )}
      {dialog === "join" && (
        <Modal title="朋友在哪一桌？" close={() => setDialog(null)} feedback={toast}>
          <p className="modal-copy">问朋友要四位房间号，输入后就能入座。</p>
          {inviteInfo && <p className="invite-preview" role="status">房间 {roomInput} · {inviteInfo.count}/8 人 · {inviteInfo.round_limit ? `${inviteInfo.round_limit} 局` : "血战到底"}<br />{inviteInfo.reason}</p>}
          {inviteError && <p className="modal-feedback" role="status">{inviteError}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              enter("join");
            }}
          >
            <label className="field-label" htmlFor="room-code">
              四位房间号
            </label>
            <input
              id="room-code"
              className="code-input"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              maxLength={4}
              pattern="[1-9][0-9]{3}"
              value={roomInput}
              onChange={(e) => {
                setRoomInput(e.target.value.replace(/\D/g, "").slice(0, 4));
                setToast("");
              }}
              placeholder="1234"
            />
            <button
              className="primary wide"
              disabled={loading || roomInput.length !== 4}
            >
              加入房间 <ArrowRight size={18} />
            </button>
          </form>
          <button className="text-button wide" onClick={returnFromInvite}>返回大厅</button>
        </Modal>
      )}
      {dialog === "profile" && (
        <Modal title="换个身份，入座吧" close={() => setDialog(null)} feedback={toast}>
          <div className="profile-editor">
            <Avatar seed={profile.avatar_seed} name={profile.name} />
            <button
              className="secondary"
              onClick={() =>
                setProfile((p) => ({ ...p, avatar_seed: randomSeed() }))
              }
            >
              <Shuffle size={16} /> 换个头像
            </button>
          </div>
          <label className="field-label" htmlFor="nickname">
            你的名字
          </label>
          <div className="name-input-row">
            <input
              id="nickname"
              maxLength={16}
              value={profile.name}
              onChange={(e) =>
                setProfile((p) => ({ ...p, name: e.target.value }))
              }
            />
            <button
              className="icon-button"
              aria-label="随机名字"
              onClick={() => setProfile((p) => ({ ...p, name: randomName() }))}
            >
              <Dice5 size={22} />
            </button>
          </div>
          <p className="field-help">最多 16 个字。名字和头像可以分别随机。</p>
          <button
            className="primary wide"
            disabled={loading || !profile.name.trim()}
            onClick={async () => {
              setLoading(true);
              try {
                await ensureSession();
                setDialog(null);
              } catch (e) {
                notify(e instanceof Error ? e.message : "保存失败");
              } finally {
                setLoading(false);
              }
            }}
          >
            就用这个名字 <Check size={18} />
          </button>
        </Modal>
      )}
      {dialog === "rules" && (
        <Modal title="一分钟，看懂干瞪眼" close={() => setDialog(null)} feedback={toast}>
          <div className="rules-list">
            {lessons.map((l, i) => (
              <section key={l.title}>
                <span>0{i + 1}</span>
                <div>
                  <h3>{l.title}</h3>
                  <p>{l.text}</p>
                </div>
              </section>
            ))}
            <section>
              <span>04</span>
              <div>
                <h3>先出完，就是赢家</h3>
                <p>
                  54 张牌，只有大小王是万能牌；庄家 6 张，其他人 5
                  张。按座位依次出牌；一圈没人接，最后出牌的人摸一张再领出。剩余牌计负分，三张炸弹
                  ×2、深水炸弹 ×4，倍率累乘。每张剩余牌计 1 分，赢家获得其他玩家扣分之和，全桌得分合计为 0。牌堆耗尽且领出者只剩万能牌时，本局和局。
                </p>
              </div>
            </section>
          </div>
          <button className="primary wide" onClick={() => setDialog(null)}>
            明白了 <Check size={18} />
          </button>
        </Modal>
      )}
      {dialog === "end" && (
        <Modal title="结束这一桌游戏？" close={() => setDialog(null)} feedback={toast}>
          <p className="modal-copy">
            房间将立即解散，所有玩家会看到总计分，并可创建或加入新房间。
            {table?.phase === "playing" ? "当前这一局尚未完成，不计分；此前已完成局的累计成绩保留。" : "已完成局的累计成绩保留。"}
          </p>
          <button className="primary wide" disabled={busy || status !== "online"} onClick={() => {
            send("end");
            setDialog(null);
          }}>确认结束游戏</button>
          <button className="text-button wide" onClick={() => setDialog(null)}>继续玩</button>
        </Modal>
      )}
      {dialog === "leave" && (
        <Modal title="先离开这一桌？" close={() => setDialog(null)} feedback={toast}>
          <p className="modal-copy">
            {waitingNext ? "离开等待席后，可以重新通过邀请链接加入。" : table?.phase === "playing" && !table.practice
              ? "本局进行中，座位和累计分数会保留到整桌结束。离线后机器接管，有牌就接、要不起就过；回来后可继续自己出牌。"
              : table && !table.practice && table.round > 0 && table.phase !== "ended"
                ? "这一桌尚未结束，返回大厅后座位和累计分数仍保留，下一局离线时由机器代打。房主结束游戏后才能加入新桌。"
                : "退出后可以重新开桌，或加入朋友的房间。"}
          </p>
          <button
            className="primary wide"
            disabled={loading}
            onClick={() =>
              table?.phase === "playing" && !table.practice && !waitingNext
                ? (setRoom(""), setDialog(null))
                : leave()
            }
          >
            {table?.phase === "playing" && !table.practice && !waitingNext
              ? "暂时离开"
              : "退出房间"}
            <DoorOpen size={18} />
          </button>
          <button className="text-button wide" onClick={() => setDialog(null)}>
            继续玩
          </button>
        </Modal>
      )}
      {toast && !dialog && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function HostBadge() {
  return <span className="host-badge" role="img" aria-label="房主" title="房主"><Crown size={12} fill="currentColor" /></span>;
}

function Seat({
  player,
  index,
  count,
  active,
  host,
}: {
  player: Player;
  index: number;
  count: number;
  active: boolean;
  host: boolean;
}) {
  const positions =
    count <= 3
      ? ["", "upper-left", "upper-right"]
      : count === 4
        ? ["", "left", "top", "right"]
        : count === 5
          ? ["", "left", "upper-left", "upper-right", "right"]
          : count === 6
            ? ["", "left", "upper-left", "top", "upper-right", "right"]
            : count === 7
              ? ["", "lower-left", "left", "upper-left", "upper-right", "right", "lower-right"]
              : ["", "lower-left", "left", "upper-left", "top", "upper-right", "right", "lower-right"];
  return (
    <div
      className={`opponent ${positions[index]} ${active ? "active" : ""} ${!player.online ? "disconnected" : ""}`}
    >
      <div className="opponent-avatar">
        <Avatar seed={player.avatar_seed} name={player.name} />
        {host && <HostBadge />}
        {active && <span className="turn-dot" />}
      </div>
      <div className="opponent-info">
        <strong>{player.name}</strong>
        <small>
          {player.pending ? "等待下一局" : player.bot
            ? "机器人"
            : player.auto_play
              ? player.online ? "托管中" : "离线 · 机器代打"
              : !player.online
              ? "离线 · 座位保留"
              : host
                ? "房主"
                : player.ready
                  ? "已准备"
                  : "未准备"}{" "}
          · 累计 {player.score} 分
        </small>
      </div>
      {player.count > 0 && (
        <div className="card-count">
          <span />
          {player.count}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
