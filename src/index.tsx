import {
  addEventListener,
  definePlugin,
  removeEventListener,
  routerHook,
  toaster,
} from "@decky/api";
import { Router, staticClasses, useParams } from "@decky/ui";

import {
  clearGuideCache,
  clearImageCache,
  downloadGuideImage,
  getCachedGuide,
  getGuide,
  getGuideLibrary,
  getGuideImage,
  getPositions,
  getReaderCacheStats,
  getReaderPosition,
  repairPositionStores,
  removeGuideCache,
  savePosition,
  saveReaderPosition,
} from "./backend";
import { NativeGuideDownloadButton } from "./components/GuideDownloadButton";
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
  resolveGuideForReaderOpen,
} from "./reader/recent-guide";
import { ReaderImageCacheControl } from "./reader/image-cache-control";
import {
  downloadGuideImages,
  type GuideImageDownloadProgress,
} from "./reader/download";
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
const GUIDE_DOWNLOAD_COMPONENT = "decky-grip-guide-download";

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
  const status = new RuntimeStatusStore(currentRunningAppId() ?? null);
  const readerPerformance = new ReaderPerformanceTracker();
  const imageCacheControl = new ReaderImageCacheControl();
  let guideCacheMutationActive = false;
  let imageCacheMutationActive = false;
  let activeGuideDownloads = 0;
  const readerCache = new ReaderSessionCache(
    {
      getCachedGuide,
      getGuide,
      getReaderPosition,
      saveReaderPosition: async (
        ...args: Parameters<typeof saveReaderPosition>
      ) => {
        const saved = await saveReaderPosition(...args);
        status.refreshGuideLibrary();
        return saved;
      },
    },
    (error: unknown) => {
      console.warn("[GRIP] Could not persist the native reader handoff", error);
    },
  );
  const mutateGuideCache = async <Result,>(
    action: () => Promise<Result>,
  ): Promise<Result> => {
    if (activeGuideDownloads > 0) {
      throw new Error("指南正在下载，完成后才能清理缓存");
    }
    if (guideCacheMutationActive) {
      throw new Error("指南正文缓存正在清理，请稍后再试");
    }
    guideCacheMutationActive = true;
    try {
      return await action();
    } finally {
      readerCache.clear();
      guideCacheMutationActive = false;
      status.refreshGuideLibrary();
    }
  };
  const controller = new GripController({
    backend: {
      getPositions,
      savePosition,
    },
    runtimeFactory: createSteamGuideRuntime,
    status,
  });
  const controllerReady = controller.start();
  const mergeReaderRecentGuides = async (appId: string | null) => {
    try {
      const entries = await getGuideLibrary(appId);
      if (mounted) {
        status.mergeRecentGuides(
          entries.map(({ appId, guideId, updatedAt }) => ({
            identity: { appId, guideId },
            updatedAt,
          })),
        );
      }
    } catch (error: unknown) {
      console.warn("[GRIP] Could not read GRIP Reader history", error);
    }
  };
  let recentGuidesReady = controllerReady.then(() =>
    mergeReaderRecentGuides(currentRunningAppId() ?? null),
  );

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
  void recentGuidesReady.then(() => preloadReaderFor(currentRunningAppId()));

  const retryPositions = async (): Promise<boolean> => {
    const loaded = await controller.retryPositions();
    await mergeReaderRecentGuides(currentRunningAppId() ?? null);
    preloadReaderFor(currentRunningAppId());
    return loaded;
  };

  let readerOpenGeneration = 0;
  const openReader = async (
    hotkeyPress?: InstrumentedHotkeyPress,
    requestedIdentity?: GuideIdentity,
  ): Promise<void> => {
    const openGeneration = ++readerOpenGeneration;
    const performanceTrace = hotkeyPress
      ? readerPerformance.begin(hotkeyPress)
      : null;
    const targetAppId = currentRunningAppId();
    const canContinue = (): boolean => {
      if (!mounted || openGeneration !== readerOpenGeneration) {
        return false;
      }
      if (currentRunningAppId() !== targetAppId) {
        throw new Error("运行中的游戏已经改变，请再按一次 L4");
      }
      if (guideCacheMutationActive) {
        throw new Error("指南正文缓存正在清理，请稍后再打开阅读器");
      }
      return true;
    };

    try {
      const identity = await resolveGuideForReaderOpen(
        requestedIdentity,
        () => resolveReaderIdentity(targetAppId),
        recentGuidesReady,
      );
      if (!canContinue()) {
        if (performanceTrace) {
          readerPerformance.abandon(performanceTrace);
        }
        return;
      }

      if (!identity) {
        throw new Error(
          targetAppId === undefined
            ? "请先打开一次 Steam 指南，再使用 GRIP 阅读器"
            : "当前游戏还没有可继续的指南，请先打开一次该游戏的 Steam 指南",
        );
      }
      makeGuideKey(identity);
      if (targetAppId !== undefined && identity.appId !== targetAppId) {
        throw new Error("游戏运行时只能打开当前游戏的指南");
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
      navigateMainWindow(
        getMainWindow(),
        `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
        true,
      );
      status.rememberGuide(identity);
      void readerCache
        .load(identity)
        .then((snapshot) => {
          if (!mounted || openGeneration !== readerOpenGeneration) {
            if (performanceTrace) {
              readerPerformance.abandon(performanceTrace);
            }
            return;
          }
          if (performanceTrace) {
            readerPerformance.markCacheReady(
              identity,
              snapshot.guide.fromCache ? "disk" : "network",
            );
          }
          if (snapshot.positionWarning === null) {
            // Opening without scrolling must still win the per-app recent order.
            void readerCache
              .rememberAccess(identity, snapshot.position)
              .catch((error: unknown) => {
                console.warn("[GRIP] Could not remember reader access", error);
              });
          }
        })
        .catch((error: unknown) => {
          if (!mounted || openGeneration !== readerOpenGeneration) {
            if (performanceTrace) {
              readerPerformance.abandon(performanceTrace);
            }
            return;
          }
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
    await mergeReaderRecentGuides(currentRunningAppId() ?? null);
    preloadReaderFor(currentRunningAppId());
    status.refreshGuideLibrary();
    const backups = [
      result.positions.backup ? `原生位置：${result.positions.backup}` : null,
      result.readerPositions.backup
        ? `阅读器位置：${result.readerPositions.backup}`
        : null,
    ].filter((value): value is string => value !== null);
    const errors = [
      result.positions.error ? `原生位置：${result.positions.error}` : null,
      result.readerPositions.error
        ? `阅读器位置：${result.readerPositions.error}`
        : null,
      !positionsReloaded
        ? (status.getSnapshot().positionWarning ?? "位置文件重读失败")
        : null,
    ].filter((value): value is string => value !== null);
    if (errors.length > 0) {
      return `${backups.length > 0 ? `已备份并重置：${backups.join("；")}。` : ""}部分本地数据恢复失败：${errors.join("；")}`;
    }
    return backups.length > 0
      ? `损坏本地数据已备份并重置。${backups.join("；")}`
      : "本地数据校验正常，无需重置。";
  };

  const clearGuides = () => mutateGuideCache(clearGuideCache);

  const cacheGuide = async (
    identity: GuideIdentity,
    onProgress?: (progress: GuideImageDownloadProgress) => void,
    forceRefresh = false,
  ) => {
    if (guideCacheMutationActive || imageCacheMutationActive) {
      throw new Error("缓存正在清理，请稍后再下载");
    }
    activeGuideDownloads += 1;
    try {
      const handoff = controller.captureReaderHandoff(identity);
      const snapshot = await readerCache.load(identity, {
        forceRefresh,
        revalidate: true,
      });
      if (mounted) {
        await readerCache.rememberAccess(
          identity,
          snapshot.position ?? handoff,
        );
      }
      await downloadGuideImages(snapshot.guide, downloadGuideImage, onProgress);
      // A warm session is not proof that its body still exists on disk.
      const saved = await getCachedGuide(identity.guideId);
      if (
        !saved ||
        saved.sections.some(
          (section, index) =>
            section.html !== snapshot.guide.sections[index]?.html,
        ) ||
        saved.sections.length !== snapshot.guide.sections.length
      ) {
        throw new Error("本地正文已变化，请重试下载");
      }
      return snapshot.guide;
    } catch (error: unknown) {
      toaster.toast({ title: "GRIP：下载未完成", body: errorMessage(error) });
      throw error;
    } finally {
      activeGuideDownloads -= 1;
      status.refreshGuideLibrary();
    }
  };

  const removeGuide = (guideId: string) =>
    mutateGuideCache(() => removeGuideCache(guideId));

  const clearImages = async () => {
    if (activeGuideDownloads > 0) {
      throw new Error("指南正在下载，完成后才能清理图片");
    }
    const token = imageCacheControl.beginClear();
    imageCacheMutationActive = true;
    try {
      const result = await clearImageCache();
      imageCacheControl.finishClear(token, true);
      return result;
    } catch (error: unknown) {
      imageCacheControl.finishClear(token, false);
      throw error;
    } finally {
      imageCacheMutationActive = false;
    }
  };

  const closeReader = (
    options: { forceLibrary?: boolean; ownerAppId?: string } = {},
  ): void => {
    readerOpenGeneration += 1;
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

  const ReaderRoute = () => {
    const params = useParams<{ appId?: string; guideId?: string }>();
    return (
      <GuideReaderPage
        cache={readerCache}
        fetchImage={getGuideImage}
        imageCacheControl={imageCacheControl}
        key={`${params.appId ?? ""}:${params.guideId ?? ""}`}
        loadGuideLibrary={getGuideLibrary}
        onClose={closeReader}
        onRepairPositions={repairPositions}
        onSwitchGuide={(identity) => openReader(undefined, identity)}
        performance={readerPerformance}
      />
    );
  };
  routerHook.addRoute(READER_ROUTE, ReaderRoute);
  routerHook.addGlobalComponent(GUIDE_DOWNLOAD_COMPONENT, () => (
    <NativeGuideDownloadButton downloadGuide={cacheGuide} status={status} />
  ));

  let lifetimeRegistration: { unregister(): void } | undefined;
  try {
    lifetimeRegistration =
      globalThis.SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications?.(
        ({ unAppID, bRunning }) => {
          if (!mounted) {
            return;
          }
          const appId = String(unAppID);
          if (bRunning) {
            status.setGuideLibraryAppId(appId);
            recentGuidesReady = controllerReady.then(() =>
              mergeReaderRecentGuides(appId),
            );
            void recentGuidesReady.then(() => preloadReaderFor(appId));
            return;
          }
          const runningAppId = currentRunningAppId();
          if (status.getSnapshot().guideLibraryAppId === appId) {
            status.setGuideLibraryAppId(
              runningAppId && runningAppId !== appId ? runningAppId : null,
            );
          } else {
            status.refreshGuideLibrary();
          }
          const path = currentMainPath();
          if (!readerBelongsToStoppedApp(path, unAppID, bRunning)) {
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
        cacheGuide={cacheGuide}
        clearGuides={clearGuides}
        clearImages={clearImages}
        getCacheStats={getReaderCacheStats}
        loadGuideLibrary={getGuideLibrary}
        openGuide={(identity) => openReader(undefined, identity)}
        openReader={openReader}
        performance={readerPerformance}
        repairPositions={repairPositions}
        removeGuideCache={removeGuide}
        retryPositions={retryPositions}
        status={status}
      />
    ),
    icon: <BookmarkIcon />,
    onDismount() {
      mounted = false;
      routerHook.removeGlobalComponent(GUIDE_DOWNLOAD_COMPONENT);
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
