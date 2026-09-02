import { useQuickAccessVisible } from "@decky/api";
import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
} from "@decky/ui";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  getHotkeyStatus,
  setGuideFavorite,
  type CacheClearResult,
  type GuideLibraryEntry,
  type HotkeyStatus,
  type ReaderCacheStats,
} from "../backend";
import type { ReaderPerformanceTracker } from "../reader/performance";
import {
  filterGuideLibraryEntries,
  guideCacheAction,
  guideCacheRefreshFellBack,
  type GuideCacheAction,
} from "../reader/recent-guide";
import type { DownloadedGuide } from "../reader/types";
import type { GripRuntimeStatus, RuntimeStatusStore } from "../runtime-status";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

export interface GripPanelProps {
  status: RuntimeStatusStore;
  openReader: () => Promise<void>;
  openGuide: (identity: GuideIdentity) => Promise<void>;
  loadGuideLibrary: (appId: string | null) => Promise<GuideLibraryEntry[]>;
  retryPositions: () => Promise<boolean>;
  performance: ReaderPerformanceTracker;
  cacheGuide: (identity: GuideIdentity) => Promise<DownloadedGuide>;
  clearGuides: () => Promise<CacheClearResult>;
  clearImages: () => Promise<CacheClearResult>;
  getCacheStats: () => Promise<ReaderCacheStats>;
  repairPositions: () => Promise<string>;
  removeGuideCache: (guideId: string) => Promise<CacheClearResult>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function describeLastAction(status: GripRuntimeStatus): string | null {
  if (status.lastRestored) {
    return `最近恢复：指南 ${status.lastRestored.guideId}，位置 ${Math.round(status.lastRestored.scrollTop)} px`;
  }
  if (status.lastCaptured) {
    return `最近保存：指南 ${status.lastCaptured.guideId}，位置 ${Math.round(status.lastCaptured.scrollTop)} px`;
  }
  return null;
}

function formatReadTime(updatedAt: number): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function describeGuide(entry: GuideLibraryEntry): string {
  const details = [
    `游戏 ${entry.appId}`,
    entry.cache
      ? entry.cache.stale
        ? "已缓存，可更新"
        : "已缓存"
      : "打开时联网下载",
    `最近记录 ${formatReadTime(entry.updatedAt)}`,
  ];
  if (entry.cache?.author) {
    details.splice(1, 0, `作者：${entry.cache.author}`);
  }
  if (entry.cache?.sectionTitle) {
    details.push(`章节：${entry.cache.sectionTitle}`);
  }
  return details.join(" · ");
}

export function GripPanel({
  status: statusStore,
  openReader,
  openGuide,
  loadGuideLibrary,
  retryPositions,
  performance,
  cacheGuide,
  clearGuides,
  clearImages,
  getCacheStats,
  repairPositions,
  removeGuideCache,
}: GripPanelProps) {
  const status = useSyncExternalStore(
    statusStore.subscribe,
    statusStore.getSnapshot,
  );
  const quickAccessVisible = useQuickAccessVisible();
  const [readerBusy, setReaderBusy] = useState<string | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [guideLibrary, setGuideLibrary] = useState<GuideLibraryEntry[] | null>(
    null,
  );
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [guideFilter, setGuideFilter] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [positionRetryBusy, setPositionRetryBusy] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<ReaderCacheStats | null>(null);
  const [cacheStatsError, setCacheStatsError] = useState<string | null>(null);
  const performanceSnapshot = useSyncExternalStore(
    performance.subscribe,
    performance.getSnapshot,
  );

  const refreshCacheStats = async (): Promise<void> => {
    setCacheStatsError(null);
    try {
      setCacheStats(await getCacheStats());
    } catch (error: unknown) {
      setCacheStats(null);
      setCacheStatsError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  useEffect(() => {
    if (!quickAccessVisible) {
      return;
    }
    let canceled = false;
    void getHotkeyStatus()
      .then((nextStatus) => {
        if (!canceled) {
          setHotkeyStatus(nextStatus);
        }
      })
      .catch(() => {
        if (!canceled) {
          setHotkeyStatus(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [quickAccessVisible]);

  useEffect(() => {
    let canceled = false;
    setCacheStatsError(null);
    void getCacheStats()
      .then((stats) => {
        if (!canceled) {
          setCacheStats(stats);
          setCacheStatsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setCacheStats(null);
          setCacheStatsError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      canceled = true;
    };
  }, [getCacheStats]);

  useEffect(() => {
    setGuideFilter("");
  }, [status.guideLibraryAppId]);

  useEffect(() => {
    if (!quickAccessVisible) {
      return;
    }
    let canceled = false;
    setGuideLibrary(null);
    setLibraryError(null);
    void loadGuideLibrary(status.guideLibraryAppId)
      .then((entries) => {
        if (!canceled) {
          setGuideLibrary(entries);
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setLibraryError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      canceled = true;
    };
  }, [
    libraryRevision,
    loadGuideLibrary,
    quickAccessVisible,
    status.guideLibraryAppId,
    status.guideLibraryRevision,
  ]);

  const runCacheAction = async <Result,>(
    action: () => Promise<Result>,
    successMessage: (result: Result) => string,
    failureLabel: string,
  ): Promise<void> => {
    if (cacheBusy) {
      return;
    }
    setCacheBusy(true);
    setCacheMessage(null);
    try {
      const result = await action();
      setCacheMessage(successMessage(result));
    } catch (error: unknown) {
      setCacheMessage(
        `${failureLabel}失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await refreshCacheStats();
      setCacheBusy(false);
    }
  };

  const runOpen = (key: string, action: () => Promise<void>): void => {
    if (readerBusy !== null || cacheBusy) {
      return;
    }
    setReaderBusy(key);
    setReaderError(null);
    void action()
      .catch((error: unknown) => {
        setReaderError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setReaderBusy(null));
  };

  const removeCachedGuide = async (entry: GuideLibraryEntry): Promise<void> => {
    const title = entry.cache?.title ?? `指南 ${entry.guideId}`;
    await runCacheAction(
      () => removeGuideCache(entry.guideId),
      (result) =>
        `“${title}”缓存已移除：释放 ${formatBytes(result.bytesRemoved)}`,
      "移除指南缓存",
    );
  };

  const cacheGuideBody = async (
    entry: GuideLibraryEntry,
    action: GuideCacheAction,
  ): Promise<void> => {
    const title = entry.cache?.title ?? `指南 ${entry.guideId}`;
    await runCacheAction(
      () => cacheGuide(entry),
      (guide) =>
        guideCacheRefreshFellBack(action, guide)
          ? `“${title}”更新失败，继续保留本地旧缓存`
          : action === "refresh"
            ? `“${title}”正文缓存已更新`
            : `“${title}”正文已缓存到本机`,
      `${action === "refresh" ? "更新" : "下载"}正文缓存`,
    );
  };

  const updateFavorite = async (
    entry: GuideLibraryEntry,
    favorite: boolean,
  ): Promise<void> => {
    if (favoriteBusy !== null) {
      return;
    }
    const guideKey = makeGuideKey(entry);
    setFavoriteBusy(guideKey);
    setReaderError(null);
    try {
      await setGuideFavorite(guideKey, favorite);
    } catch (error: unknown) {
      setReaderError(
        `收藏更新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLibraryRevision((revision) => revision + 1);
      setFavoriteBusy(null);
    }
  };

  const lastAction = describeLastAction(status);
  const visibleGuides = filterGuideLibraryEntries(
    guideLibrary ?? [],
    guideFilter,
    favoritesOnly,
  );

  return (
    <>
      <PanelSection title="指南库">
        <PanelSectionRow>
          <ButtonItem
            disabled={readerBusy !== null || cacheBusy}
            label={
              readerBusy === "recent"
                ? "正在打开 GRIP 阅读器…"
                : "继续当前或最近指南"
            }
            layout="below"
            onClick={() => runOpen("recent", openReader)}
          >
            优先继续当前游戏正在查看的指南
          </ButtonItem>
        </PanelSectionRow>
        {status.positionWarning && (
          <PanelSectionRow>
            <div style={{ color: "#f0b35a" }}>
              <div>{status.positionWarning}</div>
              <ButtonItem
                disabled={positionRetryBusy}
                label={positionRetryBusy ? "正在重试…" : "重试读取位置"}
                layout="below"
                onClick={() => {
                  setPositionRetryBusy(true);
                  void retryPositions().finally(() =>
                    setPositionRetryBusy(false),
                  );
                }}
              >
                不会影响已缓存的指南正文
              </ButtonItem>
              <ButtonItem
                disabled={positionRetryBusy}
                label="备份并重置损坏位置"
                layout="below"
                onClick={() => {
                  setPositionRetryBusy(true);
                  setRepairMessage(null);
                  void repairPositions()
                    .then(setRepairMessage)
                    .catch((error: unknown) =>
                      setRepairMessage(
                        `位置恢复失败：${error instanceof Error ? error.message : String(error)}`,
                      ),
                    )
                    .finally(() => setPositionRetryBusy(false));
                }}
              >
                仅在校验失败时备份原文件并重置
              </ButtonItem>
            </div>
          </PanelSectionRow>
        )}
        {repairMessage && (
          <PanelSectionRow>
            <div style={{ color: "#f0b35a", opacity: 0.88 }}>
              {repairMessage}
            </div>
          </PanelSectionRow>
        )}
        {cacheMessage && (
          <PanelSectionRow>
            <div style={{ opacity: 0.82 }}>{cacheMessage}</div>
          </PanelSectionRow>
        )}
        {status.phase === "error" && (
          <PanelSectionRow>
            <div style={{ color: "#ff6b6b" }}>{status.message}</div>
          </PanelSectionRow>
        )}
        {readerError && (
          <PanelSectionRow>
            <div style={{ color: "#ff6b6b" }}>{readerError}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ToggleField
            checked={showAdvanced}
            description="性能诊断、缓存维护和详细运行状态"
            label="高级选项"
            onChange={setShowAdvanced}
          />
        </PanelSectionRow>
        {guideLibrary === null && !libraryError && (
          <PanelSectionRow>
            <div style={{ opacity: 0.75 }}>正在读取最近指南…</div>
          </PanelSectionRow>
        )}
        {guideLibrary &&
          (guideLibrary.length > 1 ||
            guideFilter.length > 0 ||
            favoritesOnly) && (
            <>
              <PanelSectionRow>
                <TextField
                  bShowClearAction
                  label="筛选指南"
                  onChange={(event) =>
                    setGuideFilter(event.currentTarget.value)
                  }
                  value={guideFilter}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ToggleField
                  checked={favoritesOnly}
                  description="本地收藏固定显示在最近指南之前"
                  label="仅看收藏"
                  onChange={setFavoritesOnly}
                />
              </PanelSectionRow>
            </>
          )}
        {libraryError && (
          <PanelSectionRow>
            <div style={{ color: "#f0b35a" }}>
              <div>指南库读取失败：{libraryError}</div>
              <ButtonItem
                label="重试读取指南库"
                layout="below"
                onClick={() => setLibraryRevision((revision) => revision + 1)}
              >
                不会修改阅读位置或正文缓存
              </ButtonItem>
              <ButtonItem
                disabled={positionRetryBusy}
                label={positionRetryBusy ? "正在修复…" : "备份并修复本地数据"}
                layout="below"
                onClick={() => {
                  setPositionRetryBusy(true);
                  setRepairMessage(null);
                  void repairPositions()
                    .then(setRepairMessage)
                    .catch((error: unknown) =>
                      setRepairMessage(
                        `本地数据恢复失败：${error instanceof Error ? error.message : String(error)}`,
                      ),
                    )
                    .finally(() => {
                      setLibraryRevision((revision) => revision + 1);
                      setPositionRetryBusy(false);
                    });
                }}
              >
                仅在校验失败时备份位置或收藏文件，然后重新读取指南库
              </ButtonItem>
            </div>
          </PanelSectionRow>
        )}
        {guideLibrary?.length === 0 && (
          <PanelSectionRow>
            <div style={{ opacity: 0.75 }}>
              还没有阅读历史。先打开一次 Steam 指南，再进入 GRIP 阅读器。
            </div>
          </PanelSectionRow>
        )}
        {guideLibrary &&
          guideLibrary.length > 0 &&
          visibleGuides.length === 0 && (
            <PanelSectionRow>
              <div style={{ opacity: 0.75 }}>没有匹配的指南。</div>
            </PanelSectionRow>
          )}
        {visibleGuides.map((entry) => {
          const guideKey = `${entry.appId}:${entry.guideId}`;
          const cacheAction = guideCacheAction(entry);
          return (
            <PanelSectionRow key={guideKey}>
              <div style={{ width: "100%" }}>
                <ButtonItem
                  disabled={readerBusy !== null || cacheBusy}
                  label={
                    readerBusy === guideKey
                      ? "正在打开…"
                      : (entry.cache?.title ?? `Steam 指南 ${entry.guideId}`)
                  }
                  layout="below"
                  onClick={() =>
                    runOpen(guideKey, () =>
                      openGuide({
                        appId: entry.appId,
                        guideId: entry.guideId,
                      }),
                    )
                  }
                >
                  {describeGuide(entry)}
                </ButtonItem>
                <ToggleField
                  checked={entry.favorite}
                  disabled={
                    favoriteBusy !== null || cacheBusy || readerBusy !== null
                  }
                  description="仅保存在本机，最多收藏 20 条"
                  label={
                    favoriteBusy === guideKey
                      ? "正在保存收藏…"
                      : entry.favorite
                        ? "已收藏"
                        : "收藏"
                  }
                  onChange={(favorite) => void updateFavorite(entry, favorite)}
                />
                {showAdvanced && cacheAction && (
                  <ButtonItem
                    disabled={cacheBusy || readerBusy !== null}
                    label={
                      cacheAction === "refresh"
                        ? "更新正文缓存"
                        : "下载正文缓存"
                    }
                    layout="below"
                    onClick={() => void cacheGuideBody(entry, cacheAction)}
                  >
                    {cacheAction === "refresh"
                      ? "联网获取新版；失败时保留当前本地正文"
                      : "不打开阅读器，下载后可离线打开正文"}
                  </ButtonItem>
                )}
                {showAdvanced && entry.cache && (
                  <ButtonItem
                    disabled={cacheBusy || readerBusy !== null}
                    label="移除此指南的正文缓存"
                    layout="below"
                    onClick={() => void removeCachedGuide(entry)}
                  >
                    保留阅读位置；下次打开时重新下载
                  </ButtonItem>
                )}
              </div>
            </PanelSectionRow>
          );
        })}
      </PanelSection>
      {showAdvanced && (
        <>
          <PanelSection title="游戏内快捷键">
            <PanelSectionRow>
              <div>L4（左侧上背键）：按一次打开，再按一次关闭</div>
            </PanelSectionRow>
            <PanelSectionRow>
              <div style={{ opacity: 0.75 }}>
                {hotkeyStatus?.available
                  ? "硬件监听已就绪"
                  : "尚未检测到 Steam Deck 背键"}
                。GRIP 只读监听物理 L4，Steam Input 映射仍会执行；请把 L4
                留空，或映射为游戏未使用的 Scroll Lock。
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <div style={{ opacity: 0.82 }}>
                {performanceSnapshot.gate === "collecting"
                  ? `物理 L4 首屏门禁采集中：${performanceSnapshot.warmAttempts}/${performanceSnapshot.minimumSamples} 次暖缓存尝试（成功样本 ${performanceSnapshot.warmSamples} 次），打开失败 ${performanceSnapshot.warmOpenFailureCount} 次`
                  : `物理 L4 首屏门禁${performanceSnapshot.gate === "pass" ? "通过" : "失败"}：P95 ${Math.round(performanceSnapshot.warmP95Ms ?? 0)} ms，spinner ${performanceSnapshot.warmSpinnerCount} 次，位置失败 ${performanceSnapshot.warmPositionFailureCount} 次，打开失败 ${performanceSnapshot.warmOpenFailureCount} 次`}
                （目标 P95 ≤ {performanceSnapshot.targetMs} ms 且无 spinner）
              </div>
            </PanelSectionRow>
            {performanceSnapshot.latest && (
              <PanelSectionRow>
                <div style={{ opacity: 0.72 }}>
                  最近一次：首屏{" "}
                  {Math.round(performanceSnapshot.latest.firstScreenMs)}
                  ms · 路由{" "}
                  {Math.round(performanceSnapshot.latest.routeMountedMs)}
                  ms · 缓存{" "}
                  {Math.round(performanceSnapshot.latest.cacheReadyMs)}
                  ms · 正文帧{" "}
                  {Math.round(performanceSnapshot.latest.contentFirstFrameMs)}
                  ms · 位置{" "}
                  {Math.round(performanceSnapshot.latest.positionSettledMs)}
                  ms · {performanceSnapshot.latest.cacheKind}
                </div>
              </PanelSectionRow>
            )}
            {performanceSnapshot.latestFailure && (
              <PanelSectionRow>
                <div style={{ color: "#f0b35a", opacity: 0.82 }}>
                  最近失败：{performanceSnapshot.latestFailure.reason}（
                  {Math.round(performanceSnapshot.latestFailure.failedAtMs)}{" "}
                  ms）
                </div>
              </PanelSectionRow>
            )}
          </PanelSection>
          <PanelSection title="本地缓存">
            <PanelSectionRow>
              <div style={{ opacity: 0.78 }}>
                {cacheStats
                  ? `指南 ${cacheStats.guides.files} 个 / ${formatBytes(cacheStats.guides.bytes)}（上限 ${formatBytes(cacheStats.guides.diskLimitBytes)}）；图片 ${cacheStats.images.files} 个 / ${formatBytes(cacheStats.images.diskBytes)}（上限 ${formatBytes(cacheStats.images.diskLimitBytes)}）`
                  : cacheStatsError
                    ? `缓存用量读取失败：${cacheStatsError}`
                    : "正在读取缓存用量…"}
              </div>
            </PanelSectionRow>
            {cacheStatsError && (
              <PanelSectionRow>
                <ButtonItem
                  disabled={cacheBusy}
                  label="重试读取缓存用量"
                  layout="below"
                  onClick={() => void refreshCacheStats()}
                >
                  仅重新读取统计，不会修改缓存或阅读位置
                </ButtonItem>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <ButtonItem
                disabled={cacheBusy}
                label="清除指南正文缓存"
                layout="below"
                onClick={() =>
                  void runCacheAction(
                    clearGuides,
                    (result) =>
                      `指南缓存已清除：删除 ${result.filesRemoved} 个文件，释放 ${formatBytes(result.bytesRemoved)}`,
                    "清除指南缓存",
                  )
                }
              >
                不删除阅读位置；下次打开会重新下载正文
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                disabled={cacheBusy}
                label="清除图片缓存"
                layout="below"
                onClick={() =>
                  void runCacheAction(
                    clearImages,
                    (result) =>
                      `图片缓存已清除：删除 ${result.filesRemoved} 个文件，释放 ${formatBytes(result.bytesRemoved)}`,
                    "清除图片缓存",
                  )
                }
              >
                清除 Rust 内存 LRU 与磁盘图片；正文不受影响
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
          <PanelSection title="详细状态">
            {status.phase !== "error" && (
              <PanelSectionRow>
                <div>{status.message}</div>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <div>已保存 {status.savedCount} 个原生 Steam 指南位置</div>
            </PanelSectionRow>
            {status.activeGuide && (
              <PanelSectionRow>
                <div style={{ opacity: 0.82 }}>
                  当前指南：游戏 {status.activeGuide.appId}，指南{" "}
                  {status.activeGuide.guideId}
                </div>
              </PanelSectionRow>
            )}
            {lastAction && (
              <PanelSectionRow>
                <div style={{ opacity: 0.72 }}>{lastAction}</div>
              </PanelSectionRow>
            )}
          </PanelSection>
        </>
      )}
    </>
  );
}
