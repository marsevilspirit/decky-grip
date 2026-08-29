import type { FocusWindow } from "../hotkey/focus-guard";

export interface GripMainWindow extends FocusWindow {
  History?: { location?: { pathname?: unknown } };
  MenuStore?: { CloseSideMenus?: () => void };
  Navigate?: (
    path: string,
    replace?: boolean,
    skipIfRouteMatches?: boolean,
  ) => void;
  NavigateToRunningApp?: (replace?: boolean) => void;
}

export function mainWindowPath(
  mainWindow: GripMainWindow | null,
): string | null {
  try {
    const pathname = mainWindow?.History?.location?.pathname;
    return typeof pathname === "string" ? pathname : null;
  } catch {
    return null;
  }
}

export function navigateMainWindow(
  mainWindow: GripMainWindow | null,
  path: string,
  replace = false,
): void {
  if (!mainWindow?.Navigate) {
    throw new Error("找不到 Steam 主界面窗口");
  }
  mainWindow.Navigate(path, replace);
  closeSideMenus(mainWindow);
}

export function returnToRunningAppMainWindow(
  mainWindow: GripMainWindow | null,
): void {
  if (mainWindow?.NavigateToRunningApp) {
    mainWindow.NavigateToRunningApp(true);
    closeSideMenus(mainWindow);
    return;
  }
  navigateMainWindow(mainWindow, "/apprunning", true);
}

function closeSideMenus(mainWindow: GripMainWindow): void {
  try {
    mainWindow.MenuStore?.CloseSideMenus?.();
  } catch (error: unknown) {
    console.warn("[GRIP] Could not close Steam side menus", error);
  }
}
