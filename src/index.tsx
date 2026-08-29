import {
  addEventListener,
  definePlugin,
  removeEventListener,
  routerHook,
  toaster,
} from "@decky/api";
import { Router, staticClasses } from "@decky/ui";

import {
  clearGuideCache,
  clearImageCache,
  getCachedGuide,
  getGuide,
  getGuideImage,
  getPositions,
  getReaderCacheStats,
  getReaderPosition,
  repairPositionStores,
  savePosition,
  saveReaderPosition,
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
import { chooseObservedGuide } from "./reader/recent-guide";
import { ReaderImageCacheControl } from "./reader/image-cache-control";
import {
  parseInstrumentedHotkeyPress,
  ReaderPerformanceTracker,
  type InstrumentedHotkeyPress,
} from "./reader/performance";
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
  const readerPerformance = new ReaderPerformanceTracker();
  const imageCacheControl = new ReaderImageCacheControl();
  const readerCache = new ReaderSessionCache(
    {
      getCachedGuide,
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
      getPositions,
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
    return chooseObservedGuide(
      runtimeStatus.activeGuide,
      status.getRecentGuide(targetAppId),
      targetAppId,
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
    void readerCache.preload(identity).catch((error: unknown) => {
      console.warn("[GRIP] Could not preload the current guide", error);
    });
  };

  const stopPreloading = status.subscribe(() =>
    preloadReaderFor(currentRunningAppId()),
  );
  void controllerReady.then(() => preloadReaderFor(currentRunningAppId()));

  const openReader = async (
    hotkeyPress?: InstrumentedHotkeyPress,
  ): Promise<void> => {
    const performanceTrace = hotkeyPress
      ? readerPerformance.begin(hotkeyPress)
      : null;
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

    try {
      await controllerReady;
      if (!canContinue()) {
        if (performanceTrace) {
          readerPerformance.abandon(performanceTrace);
        }
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
      if (performanceTrace) {
        readerPerformance.bind(performanceTrace, identity);
      }

      const warmSnapshot = readerCache.peek(identity);
      if (performanceTrace && warmSnapshot) {
        readerPerformance.markCacheReady(identity, "memory");
      }
      if (!warmSnapshot?.position) {
        const handoff = controller.captureReaderHandoff(identity);
        if (handoff) {
          readerCache.stageHandoff(identity, handoff);
        }
      }

      if (!canContinue()) {
        if (performanceTrace) {
          readerPerformance.abandon(performanceTrace);
        }
        return;
      }
      if (performanceTrace) {
        readerPerformance.markRouteRequested(performanceTrace);
      }
      navigateMainWindow(getMainWindow(), readerPath(identity), true);
      void readerCache
        .load(identity)
        .then((snapshot) => {
          if (performanceTrace) {
            readerPerformance.markCacheReady(
              identity,
              snapshot.guide.fromCache ? "disk" : "network",
            );
          }
        })
        .catch((error: unknown) => {
          readerPerformance.failIdentity(
            identity,
            `指南正文加载失败：${errorMessage(error)}`,
          );
          console.warn("[GRIP] Reader content load failed", error);
        });
    } catch (error: unknown) {
      if (performanceTrace) {
        readerPerformance.fail(performanceTrace, errorMessage(error));
      }
      throw error;
    }
  };

  const repairPositions = async (): Promise<string> => {
    const result = await repairPositionStores();
    const positionsReloaded = result.positions.repaired
      ? await controller.reloadPositionsAfterRepair()
      : await controller.retryPositions();
    if (!positionsReloaded) {
      throw new Error(
        status.getSnapshot().positionWarning ?? "位置文件重读失败",
      );
    }
    const backups = [
      result.positions.backup ? `原生位置：${result.positions.backup}` : null,
      result.readerPositions.backup
        ? `阅读器位置：${result.readerPositions.backup}`
        : null,
    ].filter((value): value is string => value !== null);
    return backups.length > 0
      ? `损坏位置已备份并重置。${backups.join("；")}`
      : "位置文件校验正常，无需重置。";
  };

  const clearGuides = async () => {
    const result = await clearGuideCache();
    readerCache.clear();
    return result;
  };

  const clearImages = async () => {
    const token = imageCacheControl.beginClear();
    try {
      const result = await clearImageCache();
      imageCacheControl.finishClear(token, true);
      return result;
    } catch (error: unknown) {
      imageCacheControl.finishClear(token, false);
      throw error;
    }
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
    <GuideReaderPage
      cache={readerCache}
      fetchImage={getGuideImage}
      imageCacheControl={imageCacheControl}
      onClose={closeReader}
      onRepairPositions={repairPositions}
      performance={readerPerformance}
    />
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
  const hotkeyListener = addEventListener<[payload: unknown]>(
    "grip_hotkey",
    (payload) => {
      const instrumented = parseInstrumentedHotkeyPress(payload);
      if (payload === "L4" || instrumented) {
        void hotkeyToggle.trigger(instrumented ?? undefined);
      }
    },
  );

  return {
    name: "GRIP",
    titleView: <div className={staticClasses.Title}>GRIP</div>,
    content: (
      <GripPanel
        clearGuides={clearGuides}
        clearImages={clearImages}
        getCacheStats={getReaderCacheStats}
        openReader={openReader}
        performance={readerPerformance}
        repairPositions={repairPositions}
        retryPositions={() => controller.retryPositions()}
        status={status}
      />
    ),
    icon: <BookmarkIcon />,
    onDismount() {
      mounted = false;
      stopPreloading();
      readerPerformance.clear();
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
