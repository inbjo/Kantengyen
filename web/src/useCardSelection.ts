import { useEffect, useRef, type Dispatch, type SetStateAction, type PointerEvent } from "react";

export function useCardSelection(hand: number[], selected: number[], setSelected: Dispatch<SetStateAction<number[]>>, version: number) {
  const gesture = useRef<{
    pointer: number; x: number; y: number; first: number; initial: number[]; add: boolean; dragging: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => { gesture.current = null; }, [version, hand.join(",")]);
  const reset = () => { gesture.current = null; };
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
      if (!target || !event.currentTarget.contains(target)) return;
      const first = hand.indexOf(Number(target.dataset.card));
      if (first < 0) return;
      suppressClick.current = false;
      gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, first,
        initial: [...selected], add: !selected.includes(hand[first]), dragging: false };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const state = gesture.current;
      if (!state || event.pointerId !== state.pointer) return;
      if (!state.dragging) {
        const dx = Math.abs(event.clientX - state.x), dy = Math.abs(event.clientY - state.y);
        if (dx < 8) return;
        if (dy > dx) { reset(); return; }
        state.dragging = true;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* canceled pointer */ }
      }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card]")];
      let index = 0;
      for (let i = 0; i < buttons.length; i++) {
        const rect = buttons[i].getBoundingClientRect();
        if (event.clientX >= rect.left) index = i;
      }
      const next = new Set(state.initial);
      for (let i = Math.min(state.first,index); i <= Math.max(state.first,index); i++) {
        if (state.add) next.add(hand[i]); else next.delete(hand[i]);
      }
      setSelected([...next]); // Retracing restores cards outside the current range.
    },
    onPointerUp: () => {
      suppressClick.current = gesture.current?.dragging ?? false;
      reset();
    },
    onPointerCancel: () => {
      if (gesture.current?.dragging) setSelected(gesture.current.initial);
      reset();
    },
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault(); event.stopPropagation();
    },
  };
}
