import { useEffect, useRef, useState } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function usePwa() {
  const [online, setOnline] = useState(navigator.onLine);
  const [installed, setInstalled] = useState(() =>
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const refreshing = useRef(false);
  useEffect(() => {
    const connected = () => setOnline(navigator.onLine);
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const added = () => { setInstalled(true); setInstallPrompt(null); };
    const standalone = window.matchMedia("(display-mode: standalone)");
    const displayChanged = () => setInstalled(standalone.matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true);
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", added);
    standalone.addEventListener("change", displayChanged);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", connected);
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("appinstalled", added);
      standalone.removeEventListener("change", displayChanged);
    };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    let registering = false;
    let registration: ServiceWorkerRegistration | undefined;
    const listeners: Array<() => void> = [];
    const register = async () => {
      if (cancelled || registering || registration) return;
      registering = true;
      try {
        const next = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        if (cancelled) return;
        registration = next;
        if (next.waiting) setWaiting(next.waiting);
        const inspectWorker = () => {
          const worker = next.installing;
          if (!worker) return;
          const changed = () => {
            if (!cancelled && worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker);
          };
          worker.addEventListener("statechange", changed);
          listeners.push(() => worker.removeEventListener("statechange", changed));
          changed();
        };
        next.addEventListener("updatefound", inspectWorker);
        listeners.push(() => next.removeEventListener("updatefound", inspectWorker));
        inspectWorker();
      } catch {
        // Offline first visit or unavailable storage must not prevent ordinary play.
      } finally { registering = false; }
    };
    const update = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (registration) void registration.update().catch(() => {});
      else void register();
    };
    const controllerChanged = () => {
      if (refreshing.current) location.reload();
      else setWaiting(null);
    };
    void register();
    const timer = window.setInterval(update, 60 * 60 * 1000);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    return () => {
      cancelled = true;
      clearInterval(timer);
      listeners.forEach(remove => remove());
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    };
  }, []);
  async function install() {
    if (!installPrompt) return false;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      return true;
    } catch { return false; }
    finally { setInstallPrompt(null); }
  }
  function refresh() {
    if (!waiting || waiting.state !== "installed" || !online) return;
    refreshing.current = true;
    waiting.postMessage({ type: "ACTIVATE_UPDATE" });
  }
  return { online, installed, updateAvailable: !!waiting, install, refresh };
}
