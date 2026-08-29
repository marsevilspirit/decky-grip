import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

import {
  getHotkeyStatus,
  type CacheClearResult,
  type HotkeyStatus,
  type ReaderCacheStats,
} from "../backend";
import type { ReaderPerformanceTracker } from "../reader/performance";
import type { GripRuntimeStatus, RuntimeStatusStore } from "../runtime-status";

export interface GripPanelProps {
  status: RuntimeStatusStore;
  openReader: () => Promise<void>;
  retryPositions: () => Promise<boolean>;
  performance: ReaderPerformanceTracker;
  clearGuides: () => Promise<CacheClearResult>;
  clearImages: () => Promise<CacheClearResult>;
  getCacheStats: () => Promise<ReaderCacheStats>;
  repairPositions: () => Promise<string>;
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
    return `Last restored: guide ${status.lastRestored.guideId} at ${Math.round(status.lastRestored.scrollTop)} px`;
  }
  if (status.lastCaptured) {
    return `Last captured: guide ${status.lastCaptured.guideId} at ${Math.round(status.lastCaptured.scrollTop)} px`;
  }
  return null;
}

export function GripPanel({
  status: statusStore,
  openReader,
  retryPositions,
  performance,
  clearGuides,
  clearImages,
  getCacheStats,
  repairPositions,
}: GripPanelProps) {
  const [status, setStatus] = useState(statusStore.getSnapshot);
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [positionRetryBusy, setPositionRetryBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<ReaderCacheStats | null>(null);
  const [performanceSnapshot, setPerformanceSnapshot] = useState(
    performance.getSnapshot,
  );

  useEffect(() => {
    setStatus(statusStore.getSnapshot());
    return statusStore.subscribe(() => setStatus(statusStore.getSnapshot()));
  }, [statusStore]);

  useEffect(() => {
    setPerformanceSnapshot(performance.getSnapshot());
    return performance.subscribe(() =>
      setPerformanceSnapshot(performance.getSnapshot()),
    );
  }, [performance]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    let canceled = false;
    void getCacheStats()
      .then((stats) => {
        if (!canceled) {
          setCacheStats(stats);
        }
      })
      .catch(() => {
        if (!canceled) {
          setCacheStats(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [getCacheStats]);

  const runCacheAction = async (
    action: () => Promise<CacheClearResult>,
    label: string,
  ) => {
    if (cacheBusy) {
      return;
    }
    setCacheBusy(true);
    setCacheMessage(null);
    try {
      const result = await action();
      setCacheMessage(
        `${label}：删除 ${result.filesRemoved} 个文件，释放 ${formatBytes(result.bytesRemoved)}`,
      );
      try {
        setCacheStats(await getCacheStats());
      } catch {
        setCacheStats(null);
      }
    } catch (error: unknown) {
      setCacheMessage(
        `${label}失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setCacheBusy(false);
    }
  };

  const lastAction = describeLastAction(status);

  return (
    <>
      <PanelSection title="游戏内快捷键">
        <PanelSectionRow>
          <div>L4（左侧上背键）：按一次打开，再按一次关闭</div>
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
                  void repairPositions()
                    .then(setCacheMessage)
                    .catch((error: unknown) =>
                      setCacheMessage(
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
              ms · 路由 {Math.round(performanceSnapshot.latest.routeMountedMs)}
              ms · 缓存 {Math.round(performanceSnapshot.latest.cacheReadyMs)}
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
              {Math.round(performanceSnapshot.latestFailure.failedAtMs)} ms）
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>
      <PanelSection title="本地缓存">
        <PanelSectionRow>
          <div style={{ opacity: 0.78 }}>
            {cacheStats
              ? `指南 ${cacheStats.guides.files} 个 / ${formatBytes(cacheStats.guides.bytes)}；图片 ${cacheStats.images.files} 个 / ${formatBytes(cacheStats.images.diskBytes)}（上限 ${formatBytes(cacheStats.images.diskLimitBytes)}）`
              : "正在读取缓存用量…"}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            disabled={cacheBusy}
            label="清除指南正文缓存"
            layout="below"
            onClick={() => void runCacheAction(clearGuides, "指南缓存已清除")}
          >
            不删除阅读位置；下次打开会重新下载正文
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            disabled={cacheBusy}
            label="清除图片缓存"
            layout="below"
            onClick={() => void runCacheAction(clearImages, "图片缓存已清除")}
          >
            清除 Python 内存 LRU 与磁盘图片；正文不受影响
          </ButtonItem>
        </PanelSectionRow>
        {cacheMessage && (
          <PanelSectionRow>
            <div style={{ opacity: 0.82 }}>{cacheMessage}</div>
          </PanelSectionRow>
        )}
      </PanelSection>
      <PanelSection title="Guide resume">
        <PanelSectionRow>
          <ButtonItem
            disabled={readerBusy}
            label={
              readerBusy ? "正在打开 GRIP 阅读器…" : "在 GRIP 阅读器中继续"
            }
            layout="below"
            onClick={() => {
              setReaderBusy(true);
              setReaderError(null);
              void openReader()
                .catch((error: unknown) => {
                  setReaderError(
                    error instanceof Error ? error.message : String(error),
                  );
                })
                .finally(() => setReaderBusy(false));
            }}
          >
            独立页面，按正文位置继续阅读
          </ButtonItem>
        </PanelSectionRow>
        {readerError && (
          <PanelSectionRow>
            <div style={{ color: "#ff6b6b" }}>{readerError}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <div
            style={{ color: status.phase === "error" ? "#ff6b6b" : undefined }}
          >
            {status.message}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div>
            {status.savedCount} saved guide position
            {status.savedCount === 1 ? "" : "s"}
          </div>
        </PanelSectionRow>
        {status.activeGuide && (
          <PanelSectionRow>
            <div style={{ opacity: 0.82 }}>
              Active: app {status.activeGuide.appId}, guide{" "}
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
  );
}
