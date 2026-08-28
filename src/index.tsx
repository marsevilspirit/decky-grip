import {
  addEventListener,
  definePlugin,
  removeEventListener,
  routerHook,
  toaster,
} from "@decky/api";
import { Router, staticClasses } from "@decky/ui";

import {
  getGuide,
  getPositions,
  getReaderPosition,
  savePosition,
  saveReaderPosition,
  type PositionSnapshots,
} from "./backend";
import { GuideReaderPage } from "./components/GuideReaderPage";
import { GripPanel } from "./components/GripPanel";
import { GripController } from "./grip-controller";
import { overlayHasEditableFocus } from "./hotkey/focus-guard";
import {
  isReaderRoute,
  readerBelongsToStoppedApp,
  readerRouteAppId,
  ReaderHotkeyToggle,
} from "./hotkey/reader-toggle";
import {
  chooseObservedGuide,
  findMostRecentGuide,
} from "./reader/recent-guide";
import { ReaderSessionCache } from "./reader/session-cache";
import { RuntimeStatusStore } from "./runtime-status";
import { makeGuideKey, type GuideIdentity } from "./steam/guide-key";
import {
  mainWindowPath,
  navigateMainWindow,
  returnToRunningAppMainWindow,
} from "./steam/main-window";
import { getMainWindow } from "./steam/main-window-store";
import { createSteamGuideRuntime } from "./steam/runtime";

const READER_ROUTE = "/decky-grip/reader/:appId/:guideId";

function readerPath(identity: GuideIdentity): string {
  makeGuideKey(identity);
  return `/decky-grip/reader/${identity.appId}/${identity.guideId}`;
}

function currentMainPath(): string | null {
  return mainWindowPath(getMainWindow());
}

function currentRunningAppId(): string | undefined {
  const appId = Router.MainRunningApp?.appid;
  return appId === undefined ? undefined : String(appId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function BookmarkIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="1em"
      viewBox="0 0 24 24"
      width="1em"
    >
      <path d="M7 3.5C7 2.67 7.67 2 8.5 2h7c.83 0 1.5.67 1.5 1.5V22l-5-3.2L7 22V3.5Z" />
    </svg>
  );
}

export default definePlugin(() => {
  let mounted = true;
  const status = new RuntimeStatusStore();
  let positionSnapshots: PositionSnapshots | null = null;
  const positionsReady = getPositions().then((positions) => {
    positionSnapshots = positions;
    return positions;
  });
  const readerCache = new ReaderSessionCache(
    {
      getGuide,
      getReaderPosition,
      saveReaderPosition,
    },
    (error: unknown) => {
      console.warn("[GRIP] Could not persist the native reader handoff", error);
    },
  );
  const controller = new GripController({
    backend: {
      getPositions: () => positionsReady,
      savePosition,
    },
    runtimeFactory: createSteamGuideRuntime,
    status,
  });
  const controllerReady = controller.start();

  const resolveReaderIdentity = (
    targetAppId: string | undefined,
  ): GuideIdentity | null => {
    const runtimeStatus = status.getSnapshot();
    return (
      chooseObservedGuide(
        runtimeStatus.activeGuide,
        runtimeStatus.lastGuide,
        targetAppId,
      ) ?? findMostRecentGuide(positionSnapshots ?? {}, targetAppId)
    );
  };

  let lastPreloadKey: string | null = null;
  let lastPreloadAt = 0;
  const preloadReaderFor = (targetAppId: string | undefined): void => {
    if (!mounted) {
      return;
    }
    const identity = resolveReaderIdentity(targetAppId);
    if (!identity || readerCache.peek(identity)) {
      return;
    }
    const guideKey = makeGuideKey(identity);
    const now = Date.now();
    if (lastPreloadKey === guideKey && now - lastPreloadAt < 30_000) {
      return;
    }
    lastPreloadKey = guideKey;
    lastPreloadAt = now;
    void readerCache.load(identity).catch((error: unknown) => {
      console.warn("[GRIP] Could not preload the current guide", error);
    });
  };

  const stopPreloading = status.subscribe(() =>
    preloadReaderFor(currentRunningAppId()),
  );
  void controllerReady.then(() => preloadReaderFor(currentRunningAppId()));

  const openReader = async (): Promise<void> => {
    const targetAppId = currentRunningAppId();
    const canContinue = (): boolean => {
      if (!mounted) {
        return false;
      }
      if (currentRunningAppId() !== targetAppId) {
        throw new Error("运行中的游戏已经改变，请再按一次 L4");
      }
      return true;
    };

    await controllerReady;
    if (!canContinue()) {
      return;
    }

    const identity = resolveReaderIdentity(targetAppId);
    if (!identity) {
      throw new Error(
        targetAppId === undefined
          ? "请先打开一次 Steam 指南，再使用 GRIP 阅读器"
          : "当前游戏还没有可继续的指南，请先打开一次该游戏的 Steam 指南",
      );
    }

    if (!readerCache.peek(identity)?.position) {
      const handoff = controller.captureReaderHandoff(identity);
      if (handoff) {
        readerCache.stageHandoff(identity, handoff);
      }
    }

    if (!canContinue()) {
      return;
    }
    navigateMainWindow(getMainWindow(), readerPath(identity), true);
    void readerCache.load(identity).catch((error: unknown) => {
      console.warn("[GRIP] Reader content load failed", error);
    });
  };

  const closeReader = (
    options: { forceLibrary?: boolean; ownerAppId?: string } = {},
  ): void => {
    const mainWindow = getMainWindow();
    const ownerAppId =
      options.ownerAppId ?? readerRouteAppId(currentMainPath());
    if (!options.forceLibrary && currentRunningAppId() !== undefined) {
      returnToRunningAppMainWindow(mainWindow);
    } else {
      navigateMainWindow(
        mainWindow,
        ownerAppId ? `/library/app/${ownerAppId}` : "/library/home",
        true,
      );
    }
  };

  const ReaderRoute = () => (
    <GuideReaderPage cache={readerCache} onClose={closeReader} />
  );
  routerHook.addRoute(READER_ROUTE, ReaderRoute);

  let lifetimeRegistration: { unregister(): void } | undefined;
  try {
    lifetimeRegistration =
      globalThis.SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications?.(
        ({ unAppID, bRunning }) => {
          if (bRunning) {
            void controllerReady.then(() => preloadReaderFor(String(unAppID)));
            return;
          }
          const path = currentMainPath();
          if (!mounted || !readerBelongsToStoppedApp(path, unAppID, bRunning)) {
            return;
          }
          try {
            closeReader({
              forceLibrary: true,
              ownerAppId: String(unAppID),
            });
          } catch (error: unknown) {
            console.warn(
              "[GRIP] Could not close reader after game exit",
              error,
            );
          }
        },
      );
  } catch (error: unknown) {
    console.warn("[GRIP] Could not watch game lifetime", error);
  }

  const hotkeyToggle = new ReaderHotkeyToggle({
    currentPath: currentMainPath,
    gameIsRunning: () => currentRunningAppId() !== undefined,
    openingIsBlocked: () => overlayHasEditableFocus(getMainWindow()),
    openReader,
    closeReader,
    onError: (error) => {
      toaster.toast({
        body: errorMessage(error),
        duration: 5_000,
        title: "GRIP 快捷键无法打开指南",
      });
    },
  });
  const hotkeyListener = addEventListener<[button: string]>(
    "grip_hotkey",
    (button) => {
      if (button === "L4") {
        void hotkeyToggle.trigger();
      }
    },
  );

  return {
    name: "GRIP",
    titleView: <div className={staticClasses.Title}>GRIP</div>,
    content: <GripPanel openReader={openReader} status={status} />,
    icon: <BookmarkIcon />,
    onDismount() {
      mounted = false;
      stopPreloading();
      readerCache.clear();
      try {
        lifetimeRegistration?.unregister();
      } catch (error: unknown) {
        console.warn("[GRIP] Could not stop game lifetime watcher", error);
      }
      lifetimeRegistration = undefined;
      removeEventListener("grip_hotkey", hotkeyListener);
      hotkeyToggle.dispose();
      try {
        if (isReaderRoute(currentMainPath())) {
          closeReader();
        }
      } catch (error: unknown) {
        console.warn("[GRIP] Could not close reader during unload", error);
      }
      controller.stop();
      routerHook.removeRoute(READER_ROUTE);
      console.info("[GRIP] Unloaded");
    },
  };
});
