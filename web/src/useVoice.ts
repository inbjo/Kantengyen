import { useCallback, useEffect, useRef, useState } from "react";
import { RoomVoice, type VoiceMember } from "./voice";

export function useVoice(code: string, token: string, allowed: boolean, notify: (message: string) => void) {
  const [status, setStatus] = useState<"off" | "starting" | "online">("off");
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [members, setMembers] = useState<VoiceMember[]>([]);
  const [hasRelay, setHasRelay] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const session = useRef<RoomVoice | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const leave = useCallback(() => {
    generation.current++;
    starting.current = false;
    session.current?.dispose();
    session.current = null;
    setStatus("off");
    setMuted(false);
    setSpeakerMuted(false);
    setMembers([]);
    setBlocked(false);
  }, []);
  useEffect(() => { if (!allowed) leave(); }, [allowed, leave]);
  useEffect(() => leave, [code, token, leave]);
  const start = async () => {
    if (!allowed || starting.current || session.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      notify("麦克风需要 HTTPS（本机 localhost 也可测试），请使用安全地址打开");
      return;
    }
    if (!window.RTCPeerConnection) { notify("当前浏览器不支持房间语音"); return; }
    starting.current = true;
    setStatus("starting");
    const attempt = ++generation.current;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (attempt !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      session.current = new RoomVoice(stream, code, token, {
        ready: () => { starting.current = false; setStatus("online"); },
        closed: reason => { leave(); if (reason) notify(reason); },
        members: setMembers, relay: setHasRelay, blocked: setBlocked, error: notify,
      });
      for (const track of stream.getAudioTracks()) track.onended = () => { leave(); notify("麦克风已断开，语音已关闭"); };
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (attempt !== generation.current) return;
      leave();
      const name = error instanceof DOMException ? error.name : "";
      notify(name === "NotAllowedError" ? "未获得麦克风权限，请在浏览器设置中允许后重试"
        : name === "NotFoundError" ? "没有找到麦克风，请检查设备"
        : name === "NotReadableError" ? "麦克风无法使用，可能被其他应用占用" : "无法开启语音，请检查麦克风和浏览器权限");
    }
  };
  const toggleMuted = () => { session.current?.setMuted(!muted); setMuted(!muted); };
  const toggleSpeaker = () => { session.current?.setSpeakerMuted(!speakerMuted); setSpeakerMuted(!speakerMuted); };
  return { status, muted, speakerMuted, members, hasRelay, blocked, start, leave, toggleMuted, toggleSpeaker, resumePlayback: () => session.current?.resumePlayback() };
}
