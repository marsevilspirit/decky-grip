import { Router } from "@decky/ui";

import type { GripMainWindow } from "./main-window";

export function getMainWindow(): GripMainWindow | null {
  try {
    return (
      (Router.WindowStore?.GamepadUIMainWindowInstance as
        GripMainWindow | undefined) ?? null
    );
  } catch {
    return null;
  }
}
