import { beforePatch, Router } from "@decky/ui";

import {
  canTriggerGuideScroll,
  isGuideScrollIntent,
} from "./guide-interaction";
import type { GuideIdentity } from "./guide-key";
import { findGuideScroller, type GuideScroller } from "./guide-scroll";
import {
  normalizeGuideId,
  parseGuideRoute,
  readActiveGuide,
  type SelectedGuideStore,
} from "./guide-route";

export interface SteamLocation {
  pathname: string;
  search?: string;
  hash?: string;
  key?: string;
  state?: unknown;
}

interface SteamHistory {
  readonly location: SteamLocation;
  listen(listener: (locationOrUpdate: unknown) => void): () => void;
  replace(path: string, state?: unknown): void;
}

interface GuideMenuStore extends SelectedGuideStore {
  SetSelectedGuide(appId: number, guideId: string | null): void;
}

interface GuideWindowRouter {
  readonly BrowserWindow: Window & typeof globalThis;
  readonly History: SteamHistory;
  readonly MenuStore: {
    readonly MainMenuStore: GuideMenuStore;
  };
}

export interface GuideSelection {
  appId: string;
  guideId: string | null;
}

export interface SteamGuideRuntime {
  readonly identity: object;
  getLocation(): SteamLocation;
  getActiveGuide(): GuideIdentity | null;
  getGuideScroller(): GuideScroller | null;
  replaceLocationState(state: Record<string, unknown>): void;
  listenHistory(listener: () => void): () => void;
  listenGuideScroll(listener: (scrollTop: number) => void): () => void;
  listenGuideInteraction(listener: (scrollIntent: boolean) => void): () => void;
  listenGuideLayout(listener: () => void): () => void;
  listenWindowFocus(listener: (focused: boolean) => void): () => void;
  beforeGuideSelection(
    listener: (selection: GuideSelection) => void,
  ): () => void;
}

function readHistoryLocation(value: unknown): SteamLocation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { location?: unknown; pathname?: unknown };
  const location =
    candidate.location && typeof candidate.location === "object"
      ? (candidate.location as { pathname?: unknown })
      : candidate;

  return typeof location.pathname === "string"
    ? (location as SteamLocation)
    : null;
}

function asGuideWindow(value: unknown): GuideWindowRouter | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<GuideWindowRouter>;
  const history = candidate.History;
  const menuStore = candidate.MenuStore?.MainMenuStore;
  const browserWindow = candidate.BrowserWindow;
  if (
    !history ||
    typeof history.listen !== "function" ||
    typeof history.replace !== "function" ||
    !readHistoryLocation(history.location) ||
    !menuStore ||
    typeof menuStore.GetSelectedGuide !== "function" ||
    typeof menuStore.SetSelectedGuide !== "function" ||
    !browserWindow?.document
  ) {
    return null;
  }

  return candidate as GuideWindowRouter;
}

function invokeSafely(label: string, listener: () => void): void {
  try {
    listener();
  } catch (error) {
    console.error(`[GRIP] ${label}`, error);
  }
}

export function createSteamGuideRuntime(): SteamGuideRuntime | null {
  const mainWindow = asGuideWindow(
    Router.WindowStore?.GamepadUIMainWindowInstance,
  );
  if (!mainWindow) {
    return null;
  }

  const history = mainWindow.History;
  const menuStore = mainWindow.MenuStore.MainMenuStore;
  const browserWindow = mainWindow.BrowserWindow;
  const document = browserWindow.document;

  return {
    identity: mainWindow,
    getLocation: () => history.location,
    getActiveGuide: () => readActiveGuide(history.location.pathname, menuStore),
    getGuideScroller: () => {
      if (!readActiveGuide(history.location.pathname, menuStore)) {
        return null;
      }
      return findGuideScroller(document);
    },
    replaceLocationState: (state) => {
      const location = history.location;
      history.replace(
        `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`,
        state,
      );
    },
    listenHistory: (listener) =>
      history.listen((locationOrUpdate) => {
        if (readHistoryLocation(locationOrUpdate)) {
          invokeSafely("History listener failed", listener);
        }
      }),
    listenGuideScroll: (listener) => {
      const onScroll = (event: Event) => {
        if (!readActiveGuide(history.location.pathname, menuStore)) {
          return;
        }
        const scroller = findGuideScroller(document);
        if (scroller?.element === event.target) {
          invokeSafely("Scroll listener failed", () =>
            listener(scroller.scrollTop),
          );
        }
      };
      document.addEventListener("scroll", onScroll, true);
      return () => document.removeEventListener("scroll", onScroll, true);
    },
    listenGuideInteraction: (listener) => {
      const onInteraction = (event: Event) => {
        if (
          !canTriggerGuideScroll(event) ||
          !readActiveGuide(history.location.pathname, menuStore)
        ) {
          return;
        }
        const scroller = findGuideScroller(document);
        const target = event.target;
        if (!scroller || !(target instanceof browserWindow.Node)) {
          return;
        }
        if (
          target === scroller.element ||
          scroller.element.contains(target as Node)
        ) {
          invokeSafely("Interaction listener failed", () =>
            listener(isGuideScrollIntent(event, scroller.element)),
          );
        }
      };
      const events = [
        "wheel",
        "pointerdown",
        "pointermove",
        "touchmove",
        "keydown",
      ];
      for (const event of events) {
        document.addEventListener(event, onInteraction, true);
      }
      return () => {
        for (const event of events) {
          document.removeEventListener(event, onInteraction, true);
        }
      };
    },
    listenGuideLayout: (listener) => {
      const Observer = browserWindow.MutationObserver;
      let throttleTimer: ReturnType<typeof setTimeout> | null = null;
      const notify = () => {
        if (throttleTimer !== null) {
          return;
        }
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          invokeSafely("Layout listener failed", listener);
        }, 100);
      };
      const observer = new Observer(notify);
      if (document.body) {
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ["src"],
        });
      }
      document.addEventListener("load", notify, true);
      browserWindow.addEventListener("resize", notify);
      return () => {
        observer.disconnect();
        if (throttleTimer !== null) {
          clearTimeout(throttleTimer);
        }
        document.removeEventListener("load", notify, true);
        browserWindow.removeEventListener("resize", notify);
      };
    },
    listenWindowFocus: (listener) => {
      const onFocus = () =>
        invokeSafely("Focus listener failed", () => listener(true));
      const onBlur = () =>
        invokeSafely("Blur listener failed", () => listener(false));
      browserWindow.addEventListener("focus", onFocus);
      browserWindow.addEventListener("blur", onBlur);
      return () => {
        browserWindow.removeEventListener("focus", onFocus);
        browserWindow.removeEventListener("blur", onBlur);
      };
    },
    beforeGuideSelection: (listener) => {
      const patch = beforePatch(menuStore, "SetSelectedGuide", (args) => {
        invokeSafely("Guide selection listener failed", () => {
          const route = parseGuideRoute(history.location.pathname);
          if (!route || Number(args[0]) !== route.numericAppId) {
            return;
          }

          const rawGuideId = args[1];
          const guideId =
            rawGuideId === null || rawGuideId === undefined
              ? null
              : normalizeGuideId(rawGuideId);
          if (rawGuideId !== null && rawGuideId !== undefined && !guideId) {
            return;
          }
          listener({ appId: route.appId, guideId });
        });
      });
      return () => {
        if (!patch.hasUnpatched) {
          patch.unpatch();
        }
      };
    },
  };
}
