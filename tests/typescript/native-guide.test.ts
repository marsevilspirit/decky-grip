// @vitest-environment happy-dom

import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const decky = vi.hoisted(() => ({ reactInstance: undefined as unknown }));

vi.mock("@decky/ui", () => ({
  getGamepadNavigationTrees: () => [],
  getReactInstance: () => decky.reactInstance,
  Router: { WindowStore: {} },
  SideMenu: { Main: 1 },
}));

import {
  resolveNativeGuideActionTarget,
  resolveNativeGuideView,
} from "../../src/steam/native-guide";

function makeActionBar(): HTMLDivElement {
  const actionBar = document.createElement("div");
  actionBar.className = "Panel Focusable";
  for (let index = 0; index < 3; index += 1) {
    const button = document.createElement("button");
    button.className = "DialogButton Focusable";
    actionBar.append(button);
  }
  return actionBar;
}

describe("native Steam guide view", () => {
  afterEach(() => {
    document.body.replaceChildren();
    decky.reactInstance = undefined;
  });

  it("resolves the MainMenu guide and its focusable action bar", () => {
    const scroller = document.createElement("div");
    scroller.className = "Panel Focusable";
    scroller.style.overflowY = "auto";
    scroller.style.scrollPaddingTop = "20px";
    scroller.style.scrollPaddingBottom = "20px";
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    scroller.getBoundingClientRect = () =>
      ({ width: 700, height: 400 }) as DOMRect;
    const actionBar = makeActionBar();
    scroller.append(actionBar);
    document.body.append(scroller);

    const setLocation = vi.fn();
    let openMenu = 1;
    const mainWindow = {
      MenuStore: {
        GetOpenSideMenu: () => openMenu,
        MainMenuStore: {
          GetFocusedApp: () => ({ appid: 1_113_000 }),
          GetAppControlsLastLocation: () => ({
            pathname: "/app/1113000/overlay/guides",
            key: "guide",
          }),
          GetSelectedGuide: () => "3414883877",
          SetAppControlsLastLocation: setLocation,
        },
      },
    };
    const view = resolveNativeGuideView(mainWindow, [
      {
        m_ID: "MainNavMenuContainer",
        Root: { Element: document.body },
      },
    ]);

    expect(view?.identity).toEqual({
      appId: "1113000",
      guideId: "3414883877",
    });
    expect(view?.replaceLocationState({ grip: { scrollTop: 42 } })).toBe(true);
    expect(setLocation).toHaveBeenCalledWith(1_113_000, {
      pathname: "/app/1113000/overlay/guides",
      key: "guide",
      state: { grip: { scrollTop: 42 } },
    });

    const navigationNode = { m_rgChildren: [{}, {}, {}] };
    const NavigationContext = createContext<unknown>(null);
    decky.reactInstance = {
      memoizedProps: {},
      return: {
        memoizedProps: { node: navigationNode },
        return: {
          tag: 10,
          memoizedProps: { value: navigationNode },
          return: null,
          type: NavigationContext,
        },
      },
    };
    const target = resolveNativeGuideActionTarget(view!);
    expect(target).toEqual({
      element: actionBar,
      navigationNode,
      navigationProvider: NavigationContext,
    });

    scroller.append(makeActionBar());
    expect(resolveNativeGuideActionTarget(view!)).toBeNull();
    openMenu = 0;
    expect(
      resolveNativeGuideView(mainWindow, [
        {
          m_ID: "MainNavMenuContainer",
          Root: { Element: document.body },
        },
      ]),
    ).toBeNull();
  });
});
