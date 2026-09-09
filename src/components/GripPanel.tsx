import { useQuickAccessVisible } from "@decky/api";
import {
  ButtonItem,
  ConfirmModal,
  DropdownItem,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  gamepadDialogClasses,
  showModal,
} from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  getHotkeyStatus,
  type CacheClearResult,
  type HotkeyStatus,
  type ReaderCacheStats,
} from "../backend";
import type { ReaderPerformanceTracker } from "../reader/performance";
import type { GripRuntimeStatus, RuntimeStatusStore } from "../runtime-status";
import { BusyLabel } from "./BusyLabel";

export interface GripPanelProps {
  status: RuntimeStatusStore;
  openReader: () => Promise<void>;
  openImport?: () => Promise<void>;
  retryPositions: () => Promise<boolean>;
  performance: ReaderPerformanceTracker;
  clearGuides: () => Promise<CacheClearResult>;
  clearImages: () => Promise<CacheClearResult>;
  getCacheStats: () => Promise<ReaderCacheStats>;
  setImageLimit: (bytes: number) => Promise<ReaderCacheStats["images"]>;
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
    return `最近恢复：指南 ${status.lastRestored.guideId}，位置 ${Math.round(status.lastRestored.scrollTop)} px`;
  }
  if (status.lastCaptured) {
    return `最近保存：指南 ${status.lastCaptured.guideId}，位置 ${Math.round(status.lastCaptured.scrollTop)} px`;
  }
  return null;
}

export function GripPanel({
  status: statusStore,
  openReader,
  openImport,
  retryPositions,
  performance,
  clearGuides,
  clearImages,
  getCacheStats,
  setImageLimit,
  repairPositions,
}: GripPanelProps) {
  const status = useSyncExternalStore(
    statusStore.subscribe,
    statusStore.getSnapshot,
  );
  const quickAccessVisible = useQuickAccessVisible();
  const [opening, setOpening] = useState<"reader" | "import" | null>(null);
  const readerBusy = opening !== null;
  const [readerError, setReaderError] = useState<string | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  const [positionBusy, setPositionBusy] = useState<"retry" | "repair" | null>(
    null,
  );
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cacheBusyKey, setCacheBusyKey] = useState<string | null>(null);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<ReaderCacheStats | null>(null);
  const [cacheStatsError, setCacheStatsError] = useState<string | null>(null);
  const [cacheStatsLoading, setCacheStatsLoading] = useState(false);
  const [cacheStatsRevision, setCacheStatsRevision] = useState(0);
  const mounted = useRef(true);
  const readerBusyRef = useRef(false);
  const cacheBusyRef = useRef(false);
  const positionBusyRef = useRef(false);
  const statsGeneration = useRef(0);
  const confirmation = useRef<ReturnType<typeof showModal> | null>(null);
  const performanceSnapshot = useSyncExternalStore(
    performance.subscribe,
    performance.getSnapshot,
  );
  const cacheBusy = cacheBusyKey !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      statsGeneration.current++;
      confirmation.current?.Close();
      confirmation.current = null;
    };
  }, []);

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
    const generation = ++statsGeneration.current;
    if (!quickAccessVisible || !showAdvanced || cacheBusyRef.current) return;
    const current = () =>
      mounted.current && statsGeneration.current === generation;
    setCacheStatsLoading(true);
    setCacheStatsError(null);
    void getCacheStats()
      .then((stats) => {
        if (current()) {
          setCacheStats(stats);
          setCacheStatsError(null);
        }
      })
      .catch((error: unknown) => {
        if (current()) {
          setCacheStats(null);
          setCacheStatsError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (current()) setCacheStatsLoading(false);
      });
    return () => {
      statsGeneration.current++;
    };
  }, [
    getCacheStats,
    quickAccessVisible,
    showAdvanced,
    status.downloadRevision,
    cacheStatsRevision,
    cacheBusyKey,
  ]);

  const runCacheAction = async <Result,>(
    busyKey: string,
    action: () => Promise<Result>,
    successMessage: (result: Result) => string,
    failureLabel: string,
  ): Promise<void> => {
    if (!mounted.current || cacheBusyRef.current || readerBusyRef.current) {
      return;
    }
    cacheBusyRef.current = true;
    statsGeneration.current++;
    setCacheBusyKey(busyKey);
    setCacheMessage(null);
    try {
      const result = await action();
      if (mounted.current) setCacheMessage(successMessage(result));
    } catch (error: unknown) {
      if (mounted.current)
        setCacheMessage(
          `${failureLabel}失败：${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      cacheBusyRef.current = false;
      if (mounted.current) {
        setCacheBusyKey(null);
        setCacheStatsRevision((value) => value + 1);
      }
    }
  };

  const confirmCacheAction = (kind: "guides" | "images"): void => {
    if (
      confirmation.current ||
      cacheBusyRef.current ||
      readerBusyRef.current ||
      !mounted.current
    )
      return;
    let settled = false;
    let modal: ReturnType<typeof showModal> | null = null;
    const closed = () => {
      settled = true;
      if (confirmation.current === modal) confirmation.current = null;
    };
    const cancel = () => {
      closed();
      modal?.Close();
    };
    const title = kind === "guides" ? "清除指南正文缓存" : "清除图片缓存";
    modal = showModal(
      <ConfirmModal
        bDestructiveWarning
        strTitle={title}
        strDescription={
          kind === "guides"
            ? "将移除所有缓存正文，包括已下载指南。阅读位置会保留，但下次打开需要联网重新下载。"
            : "将移除所有缓存图片，包括离线下载的图片。正文和阅读位置保留，但图片需要联网重新下载。"
        }
        strOKButtonText="确认清除"
        strCancelButtonText="保留，返回"
        onCancel={cancel}
        onOK={() => {
          if (settled || !mounted.current) return;
          cancel();
          void runCacheAction(
            `clear-${kind}`,
            kind === "guides" ? clearGuides : clearImages,
            (result) =>
              `${kind === "guides" ? "指南" : "图片"}缓存已清除：删除 ${result.filesRemoved} 个文件，释放 ${formatBytes(result.bytesRemoved)}`,
            title,
          );
        }}
      />,
      undefined,
      { fnOnClose: closed },
    );
    confirmation.current = modal;
  };

  const runOpen = (kind: "reader" | "import"): void => {
    const action = kind === "import" ? openImport : openReader;
    if (readerBusyRef.current || cacheBusyRef.current || !mounted.current) {
      return;
    }
    if (!action) return;
    readerBusyRef.current = true;
    setOpening(kind);
    setReaderError(null);
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        if (mounted.current)
          setReaderError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        readerBusyRef.current = false;
        if (mounted.current) setOpening(null);
      });
  };

  const runPositionAction = async (kind: "retry" | "repair"): Promise<void> => {
    if (positionBusyRef.current || !mounted.current) return;
    positionBusyRef.current = true;
    setPositionBusy(kind);
    setRepairMessage(null);
    try {
      const message =
        kind === "repair"
          ? await repairPositions()
          : (await retryPositions())
            ? "阅读位置已重新读取"
            : "仍未能读取阅读位置，请查看上方原因后重试或备份重置。";
      if (mounted.current) setRepairMessage(message);
    } catch (error: unknown) {
      if (mounted.current)
        setRepairMessage(
          `位置恢复失败：${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      positionBusyRef.current = false;
      if (mounted.current) setPositionBusy(null);
    }
  };

  const lastAction = describeLastAction(status);

  return (
    <>
      <PanelSection title="阅读器">
        {openImport && (
          <PanelSectionRow>
            <ButtonItem
              description="从小黑盒分享链接保存完整离线图文"
              layout="below"
              disabled={readerBusy || cacheBusy}
              onClick={() => runOpen("import")}
            >
              {opening === "import" ? (
                <BusyLabel>正在打开导入窗口…</BusyLabel>
              ) : (
                "导入攻略"
              )}
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            disabled={readerBusy || cacheBusy}
            description="继续当前游戏上次阅读的本地指南，不受 Steam 网页浏览影响"
            layout="below"
            onClick={() => runOpen("reader")}
          >
            {opening === "reader" ? (
              <BusyLabel>正在打开 GRIP 阅读器…</BusyLabel>
            ) : (
              "继续当前或最近指南"
            )}
          </ButtonItem>
        </PanelSectionRow>
        {status.positionWarning && (
          <>
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                {status.positionWarning}
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                disabled={positionBusy !== null}
                description="不会影响已缓存的指南正文"
                layout="below"
                onClick={() => void runPositionAction("retry")}
              >
                {positionBusy === "retry" ? (
                  <BusyLabel>正在重试…</BusyLabel>
                ) : (
                  "重试读取位置"
                )}
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                disabled={positionBusy !== null}
                description="仅在校验失败时备份原文件并重置"
                layout="below"
                onClick={() => void runPositionAction("repair")}
              >
                {positionBusy === "repair" ? (
                  <BusyLabel>正在备份并重置…</BusyLabel>
                ) : (
                  "备份并重置损坏位置"
                )}
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}
        {repairMessage && (
          <PanelSectionRow>
            <div
              role="status"
              className={gamepadDialogClasses.FieldDescription}
            >
              {repairMessage}
            </div>
          </PanelSectionRow>
        )}
        {cacheMessage && (
          <PanelSectionRow>
            <div
              role="status"
              className={gamepadDialogClasses.FieldDescription}
            >
              {cacheMessage}
            </div>
          </PanelSectionRow>
        )}
        {status.phase === "error" && (
          <PanelSectionRow>
            <div role="alert" className={gamepadDialogClasses.FieldDescription}>
              {status.message}
            </div>
          </PanelSectionRow>
        )}
        {readerError && (
          <PanelSectionRow>
            <div role="alert" className={gamepadDialogClasses.FieldDescription}>
              {readerError}
            </div>
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
      </PanelSection>
      {showAdvanced && (
        <>
          <PanelSection title="游戏内快捷键">
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                L4（左侧上背键）：按一次打开，再按一次关闭
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                {hotkeyStatus?.available
                  ? "硬件监听已就绪"
                  : "尚未检测到 Steam Deck 背键"}
                。GRIP 只读监听物理 L4，Steam Input 映射仍会执行；请把 L4
                留空，或映射为游戏未使用的 Scroll Lock。
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                {performanceSnapshot.gate === "collecting"
                  ? `L4 检测后首屏门禁采集中：${performanceSnapshot.warmAttempts}/${performanceSnapshot.minimumSamples} 次暖缓存尝试（成功样本 ${performanceSnapshot.warmSamples} 次），打开失败 ${performanceSnapshot.warmOpenFailureCount} 次`
                  : `L4 检测后首屏门禁${performanceSnapshot.gate === "pass" ? "通过" : "失败"}：P95 ${Math.round(performanceSnapshot.warmP95Ms ?? 0)} ms，spinner ${performanceSnapshot.warmSpinnerCount} 次，位置失败 ${performanceSnapshot.warmPositionFailureCount} 次，打开失败 ${performanceSnapshot.warmOpenFailureCount} 次`}
                （目标 P95 ≤ {performanceSnapshot.targetMs} ms 且无 spinner）
                。从后端读到 L4 开始计时，不包含实体按下到设备报告到达的时间。
              </div>
            </PanelSectionRow>
            {performanceSnapshot.latest && (
              <PanelSectionRow>
                <div className={gamepadDialogClasses.FieldDescription}>
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
                <div className={gamepadDialogClasses.FieldDescription}>
                  最近失败：{performanceSnapshot.latestFailure.reason}（
                  {Math.round(performanceSnapshot.latestFailure.failedAtMs)}{" "}
                  ms）
                </div>
              </PanelSectionRow>
            )}
          </PanelSection>
          <PanelSection title="本地缓存">
            <PanelSectionRow>
              <DropdownItem
                label={
                  cacheBusyKey === "limit" ? (
                    <BusyLabel>正在保存额度…</BusyLabel>
                  ) : (
                    "图片离线额度"
                  )
                }
                description="额度满后不会删除已下载图片；单篇删除请在阅读器按 Y。"
                disabled={cacheBusy || readerBusy || !cacheStats}
                selectedOption={cacheStats?.images.diskLimitBytes}
                rgOptions={[64, 128, 256, 512, 1024, 2048, 4096, 8192].map(
                  (mib) => ({
                    data: mib * 1024 * 1024,
                    label: mib < 1024 ? `${mib} MiB` : `${mib / 1024} GiB`,
                  }),
                )}
                onChange={(option) =>
                  void runCacheAction(
                    "limit",
                    () => setImageLimit(option.data as number),
                    () => "图片离线额度已保存",
                    "保存额度",
                  )
                }
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                {cacheStats
                  ? `指南 ${cacheStats.guides.files} 个 / ${formatBytes(cacheStats.guides.bytes)}（自动缓存额度 ${formatBytes(cacheStats.guides.diskLimitBytes)}，已下载正文不自动删除）；图片 ${cacheStats.images.files} 个 / ${formatBytes(cacheStats.images.diskBytes)}（其中离线 ${formatBytes(cacheStats.images.offlineBytes)}，上限 ${formatBytes(cacheStats.images.diskLimitBytes)}）`
                  : cacheStatsError
                    ? `缓存用量读取失败：${cacheStatsError}`
                    : "正在读取缓存用量…"}
              </div>
              {cacheStats && cacheStatsLoading && (
                <BusyLabel>正在刷新缓存用量…</BusyLabel>
              )}
            </PanelSectionRow>
            {cacheStatsError && (
              <PanelSectionRow>
                <ButtonItem
                  disabled={cacheBusy || cacheStatsLoading}
                  description="仅重新读取统计，不会修改缓存或阅读位置"
                  layout="below"
                  onClick={() => {
                    if (
                      !cacheBusyRef.current &&
                      !cacheStatsLoading &&
                      mounted.current
                    )
                      setCacheStatsRevision((value) => value + 1);
                  }}
                >
                  {cacheStatsLoading ? (
                    <BusyLabel>正在读取…</BusyLabel>
                  ) : (
                    "重试读取缓存用量"
                  )}
                </ButtonItem>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <ButtonItem
                disabled={cacheBusy || readerBusy}
                description="包括已下载正文；保留阅读位置，下次需要联网下载"
                layout="below"
                onClick={() => confirmCacheAction("guides")}
              >
                {cacheBusyKey === "clear-guides" ? (
                  <BusyLabel>正在清除…</BusyLabel>
                ) : (
                  "清除指南正文缓存"
                )}
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                disabled={cacheBusy || readerBusy}
                description="包括离线图片；正文和阅读位置保留"
                layout="below"
                onClick={() => confirmCacheAction("images")}
              >
                {cacheBusyKey === "clear-images" ? (
                  <BusyLabel>正在清除…</BusyLabel>
                ) : (
                  "清除图片缓存"
                )}
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
          <PanelSection title="详细状态">
            {status.phase !== "error" && (
              <PanelSectionRow>
                <div className={gamepadDialogClasses.FieldDescription}>
                  {status.message}
                </div>
              </PanelSectionRow>
            )}
            <PanelSectionRow>
              <div className={gamepadDialogClasses.FieldDescription}>
                已保存 {status.savedCount} 个原生 Steam 指南位置
              </div>
            </PanelSectionRow>
            {status.activeGuide && (
              <PanelSectionRow>
                <div className={gamepadDialogClasses.FieldDescription}>
                  当前指南：游戏 {status.activeGuide.appId}，指南{" "}
                  {status.activeGuide.guideId}
                </div>
              </PanelSectionRow>
            )}
            {lastAction && (
              <PanelSectionRow>
                <div className={gamepadDialogClasses.FieldDescription}>
                  {lastAction}
                </div>
              </PanelSectionRow>
            )}
          </PanelSection>
        </>
      )}
    </>
  );
}
