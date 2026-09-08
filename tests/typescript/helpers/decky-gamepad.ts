import {
  GamepadButton,
  type GamepadEvent,
} from "@decky/ui/dist/components/FooterLegend.js";
import type { Ref } from "react";

export { GamepadButton };

const handlers = [
  "onButtonDown",
  "onButtonUp",
  "onOKButton",
  "onCancel",
  "onOptionsButton",
  "onSecondaryButton",
  "onGamepadDirection",
  "onGamepadFocus",
  "onGamepadBlur",
] as const;
export type GamepadHandler = (typeof handlers)[number];

// ponytail: model DOM propagation only; Steam's focus routing needs device acceptance.
export function gamepadEvent(
  handler: GamepadHandler,
  button: GamepadButton,
  repeat = false,
): GamepadEvent {
  return new CustomEvent(handler, {
    bubbles: true,
    cancelable: true,
    detail: { button, is_repeat: repeat, source: 0 },
  });
}

export function gamepadRef(
  ref: Ref<HTMLElement> | undefined,
  props: Record<string, unknown>,
) {
  let cleanup = () => {};
  return (node: HTMLElement | null) => {
    cleanup();
    const listeners: Array<[GamepadHandler, EventListener]> = [];
    if (node) {
      for (const handler of handlers) {
        if (typeof props[handler] !== "function") continue;
        const listener = props[handler] as EventListener;
        node.addEventListener(handler, listener);
        listeners.push([handler, listener]);
      }
    }
    cleanup = () => {
      for (const [handler, listener] of listeners)
        node?.removeEventListener(handler, listener);
    };
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
}
