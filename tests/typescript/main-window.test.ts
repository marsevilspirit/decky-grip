import { describe, expect, it, vi } from "vitest";

import {
  mainWindowPath,
  navigateMainWindow,
  returnToRunningAppMainWindow,
  type GripMainWindow,
} from "../../src/steam/main-window";

describe("Steam main-window navigation", () => {
  it("replaces the current history entry before closing side menus", () => {
    const navigate = vi.fn();
    const closeSideMenus = vi.fn();
    const mainWindow: GripMainWindow = {
      MenuStore: { CloseSideMenus: closeSideMenus },
      Navigate: navigate,
    };

    navigateMainWindow(mainWindow, "/decky-grip/reader/1113000/10", true);

    expect(navigate).toHaveBeenCalledWith(
      "/decky-grip/reader/1113000/10",
      true,
    );
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(
      closeSideMenus.mock.invocationCallOrder[0],
    );
  });

  it("returns to the running app with replacement semantics", () => {
    const navigateToRunningApp = vi.fn();
    returnToRunningAppMainWindow({
      NavigateToRunningApp: navigateToRunningApp,
    });
    expect(navigateToRunningApp).toHaveBeenCalledWith(true);
  });

  it("falls back to replacing the running-app route", () => {
    const navigate = vi.fn();
    returnToRunningAppMainWindow({ Navigate: navigate });
    expect(navigate).toHaveBeenCalledWith("/apprunning", true);
  });

  it("tolerates a rebuilt Steam history object", () => {
    const mainWindow = {
      get History(): never {
        throw new Error("dead object");
      },
    } as GripMainWindow;
    expect(mainWindowPath(mainWindow)).toBeNull();
  });

  it("does not grow history across one hundred reader toggles", () => {
    const entries = ["/library/home", "/apprunning"];
    let index = 1;
    let pushes = 0;
    const navigate = (path: string, replace = false) => {
      if (replace) {
        entries[index] = path;
        return;
      }
      entries.splice(index + 1, entries.length, path);
      index += 1;
      pushes += 1;
    };
    const mainWindow: GripMainWindow = {
      Navigate: navigate,
      NavigateToRunningApp: (replace) => navigate("/apprunning", replace),
    };
    const baseline = entries.length;

    for (let iteration = 0; iteration < 100; iteration += 1) {
      navigateMainWindow(
        mainWindow,
        "/decky-grip/reader/1113000/3414883877",
        true,
      );
      navigateMainWindow(
        mainWindow,
        "/decky-grip/reader/1113000/3414883878",
        true,
      );
      returnToRunningAppMainWindow(mainWindow);
    }

    expect(entries).toHaveLength(baseline);
    expect(entries[index]).toBe("/apprunning");
    expect(
      entries.some((entry) => entry.startsWith("/decky-grip/reader/")),
    ).toBe(false);
    expect(pushes).toBe(0);
  });
});
