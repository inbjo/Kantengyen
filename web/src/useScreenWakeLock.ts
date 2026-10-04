import { useEffect, useState } from "react";

export function useScreenWakeLock(enabled: boolean) {
  const supported = window.isSecureContext && typeof navigator.wakeLock?.request === "function";
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(false);
    if (!enabled || !supported) return;
    let cancelled = false;
    let pending = false;
    let lock: WakeLockSentinel | null = null;
    const release = () => {
      const previous = lock;
      lock = null;
      if (!cancelled) setActive(false);
      if (previous) void previous.release().catch(() => {});
    };
    const acquire = async () => {
      if (cancelled || pending || lock || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled || document.visibilityState !== "visible") {
          await next.release();
          return;
        }
        if (next.released) return;
        lock = next;
        setActive(true);
        next.addEventListener("release", () => {
          if (lock !== next) return;
          lock = null;
          if (!cancelled) setActive(false);
        });
      } catch {
        // Power-saving settings or the browser may deny the request.
      } finally {
        pending = false;
      }
    };
    const visibility = () => {
      if (document.visibilityState === "visible") void acquire();
      else release();
    };
    void acquire();
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerup", acquire);
    document.addEventListener("keydown", acquire);
    window.addEventListener("focus", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerup", acquire);
      document.removeEventListener("keydown", acquire);
      window.removeEventListener("focus", acquire);
      release();
    };
  }, [enabled, supported]);
  return { supported, active };
}
