import {
  findModuleExport,
  Focusable as SteamFocusable,
  type FocusableProps,
  type GamepadEvent,
} from "@decky/ui";
import type { FC, RefAttributes, RefObject } from "react";

// Steam supports explicit focus registration; @decky/ui's declaration omits it.
// This is the original component, not a replacement navigation implementation.
export const Focusable = SteamFocusable as FC<
  FocusableProps & RefAttributes<HTMLDivElement> & { focusable?: boolean }
>;

type NativeScrollHook = (
  ref: RefObject<HTMLElement | null>,
  behavior?: ScrollBehavior,
  stepPercent?: number,
  shouldScroll?: (event: GamepadEvent) => boolean,
) => ((event: GamepadEvent) => boolean) | null;

// Resolve once: the selected hook cannot change between renders. Missing Steam
// support is explicit (null), so callers can retain their compatibility path.
export const useNativeScrollOnGamepadDirection: NativeScrollHook =
  (findModuleExport(
    (value: unknown) =>
      typeof value === "function" &&
      value.toString().includes("ScrollOnGamepadDirection top:"),
  ) as NativeScrollHook | undefined) ?? (() => null);
