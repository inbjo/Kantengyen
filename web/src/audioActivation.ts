// Mouse activation begins on down; touch/pen activation begins on up. Capture
// keeps unlocking inside the gesture, before a button navigates or goes fullscreen.
export function listenForAudioActivation(unlock: () => void) {
  const activate = (event: Event) => {
    if (event.type === "pointerdown" && (event as PointerEvent).pointerType !== "mouse") return;
    unlock();
  };
  const events = ["pointerdown", "pointerup", "touchend", "click", "keydown"];
  for (const event of events) document.addEventListener(event, activate, { capture: true, passive: true });
  return () => {
    for (const event of events) document.removeEventListener(event, activate, true);
  };
}
