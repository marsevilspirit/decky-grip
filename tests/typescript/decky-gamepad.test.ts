// @vitest-environment happy-dom

import { GamepadButton as InstalledGamepadButton } from "@decky/ui/dist/components/FooterLegend.js";
import { expect, it, vi } from "vitest";
import {
  GamepadButton,
  gamepadEvent,
  gamepadRef,
} from "./helpers/decky-gamepad";

it("uses Decky's installed button enum and dispatches repeat/source/target through native events", () => {
  expect(GamepadButton).toBe(InstalledGamepadButton);
  expect([
    GamepadButton.OK,
    GamepadButton.CANCEL,
    GamepadButton.BUMPER_LEFT,
    GamepadButton.BUMPER_RIGHT,
    GamepadButton.DIR_UP,
    GamepadButton.DIR_DOWN,
    GamepadButton.DIR_LEFT,
    GamepadButton.DIR_RIGHT,
  ]).toEqual([1, 2, 5, 6, 9, 10, 11, 12]);
  const parent = document.createElement("div");
  const child = document.createElement("button");
  parent.append(child);
  const receive = vi.fn((event: CustomEvent) => {
    expect(event.target).toBe(child);
    expect(event.currentTarget).toBe(parent);
  });
  const ref = gamepadRef(undefined, { onButtonDown: receive });
  ref(parent);
  const event = gamepadEvent("onButtonDown", GamepadButton.BUMPER_RIGHT, true);
  expect(event).toBeInstanceOf(CustomEvent);
  expect(event.detail).toEqual({
    button: InstalledGamepadButton.BUMPER_RIGHT,
    is_repeat: true,
    source: 0,
  });
  child.dispatchEvent(event);
  expect(receive).toHaveBeenCalledOnce();
  ref(null);
  child.dispatchEvent(gamepadEvent("onButtonDown", GamepadButton.BUMPER_RIGHT));
  expect(receive).toHaveBeenCalledOnce();
});
