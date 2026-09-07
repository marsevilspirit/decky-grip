import { DialogButton } from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { GuideDownloadStatus } from "../backend";
import type { GuideDownloadTasks } from "../reader/download";
import type { RuntimeStatusStore } from "../runtime-status";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import {
  findNativeGuideActionTarget,
  type NativeGuideActionTarget,
} from "../steam/native-guide";
import { BusyLabel } from "./BusyLabel";

export interface GuideDownloadButtonProps {
  identity: GuideIdentity | null;
  target: NativeGuideActionTarget | null;
  getDownloadStatus: (guideId: string) => Promise<GuideDownloadStatus>;
  openGuide: (identity: GuideIdentity) => Promise<void>;
  revision?: number;
  downloads: GuideDownloadTasks;
}

export interface NativeGuideDownloadButtonProps {
  status: RuntimeStatusStore;
  downloads: GuideDownloadTasks;
  getDownloadStatus: GuideDownloadButtonProps["getDownloadStatus"];
  openGuide: GuideDownloadButtonProps["openGuide"];
}

function sameTarget(
  left: NativeGuideActionTarget | null,
  right: NativeGuideActionTarget | null,
): boolean {
  return (
    left?.element === right?.element &&
    left?.navigationNode === right?.navigationNode &&
    left?.navigationProvider === right?.navigationProvider
  );
}

function useNativeGuideActionTarget(
  identity: GuideIdentity | null,
): NativeGuideActionTarget | null {
  const [target, setTarget] = useState<NativeGuideActionTarget | null>(null);

  useEffect(() => {
    if (!identity) {
      setTarget(null);
      return;
    }
    const refresh = () => {
      const next = findNativeGuideActionTarget(identity);
      setTarget((current) => (sameTarget(current, next) ? current : next));
    };
    refresh();
    const timer = setInterval(refresh, 250);
    return () => clearInterval(timer);
  }, [identity]);

  return target;
}

function GuideDownloadButtonForGuide({
  identity,
  target,
  downloads,
  getDownloadStatus,
  openGuide,
  revision = 0,
}: Omit<GuideDownloadButtonProps, "identity"> & {
  identity: GuideIdentity;
}) {
  const [downloadStatus, setDownloadStatus] =
    useState<GuideDownloadStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const [operation, setOperation] = useState<"open" | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const task = useSyncExternalStore(downloads.subscribe, () =>
    downloads.getSnapshot(identity.guideId),
  );
  const downloading =
    task?.phase === "downloading" || task?.phase === "canceling";
  const progress = task?.progress;
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (operation !== null || downloading) return;
    let canceled = false;
    setChecking(true);
    setCheckError(null);
    void getDownloadStatus(identity.guideId)
      .then((status) => {
        if (!canceled && !busyRef.current) setDownloadStatus(status);
      })
      .catch((error: unknown) => {
        if (!canceled && !busyRef.current)
          setCheckError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!canceled && !busyRef.current) setChecking(false);
      });
    return () => {
      canceled = true;
    };
  }, [
    getDownloadStatus,
    identity.guideId,
    revision,
    checkRevision,
    operation,
    downloading,
  ]);

  const activate = async (): Promise<void> => {
    if (busyRef.current || !mountedRef.current) return;
    const currentTask = downloads.getSnapshot(identity.guideId);
    if (
      currentTask?.phase === "canceling" ||
      (currentTask?.progress?.publishing && currentTask.phase === "downloading")
    )
      return;
    if (currentTask?.phase === "downloading") {
      busyRef.current = true;
      downloads.cancel(identity.guideId);
      queueMicrotask(() => {
        busyRef.current = false;
      });
      return;
    }
    if (checking) return;
    if (checkError || !downloadStatus) {
      setChecking(true);
      setCheckRevision((value) => value + 1);
      return;
    }
    if (downloadStatus.state !== "complete") {
      busyRef.current = true;
      void downloads.start(identity);
      queueMicrotask(() => {
        busyRef.current = false;
      });
      return;
    }
    busyRef.current = true;
    setOperation("open");
    setOpenError(null);
    try {
      await openGuide(identity);
    } catch (error: unknown) {
      if (mountedRef.current)
        setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setChecking(true);
        setOperation(null);
        setCheckRevision((value) => value + 1);
      }
    }
  };

  if (!target) {
    return null;
  }

  const NavigationProvider = target.navigationProvider;
  const blocked =
    operation !== null ||
    (!downloading && checking) ||
    task?.phase === "canceling" ||
    (downloading && progress?.publishing);
  const completed = Math.max(
    0,
    Math.min(progress?.completed ?? 0, progress?.total ?? 0),
  );
  const total = Math.max(0, progress?.total ?? 0);
  const progressText =
    task?.phase === "canceling"
      ? "正在停止下载，已保存的图片会保留"
      : progress?.publishing
        ? "图片已齐全，正在保存新版…"
        : progress?.stopped
          ? "空间不足，已停止后续下载"
          : total > 0
            ? `图片 ${completed}/${total} · ${Math.floor((completed / total) * 100)}%`
            : "正在下载指南正文…";
  return createPortal(
    <NavigationProvider value={target.navigationNode}>
      <div
        data-grip-guide-actions="true"
        style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 0" }}
      >
        <DialogButton
          aria-disabled={Boolean(blocked)}
          aria-busy={Boolean(blocked)}
          data-grip-guide-download="true"
          focusable
          onClick={() => void activate()}
        >
          {operation !== null ||
          (!downloading && checking) ||
          task?.phase === "canceling" ||
          (downloading && progress?.publishing) ? (
            <BusyLabel>
              {operation === "open"
                ? "正在打开…"
                : task?.phase === "canceling"
                  ? "正在停止下载…"
                  : downloading && progress?.publishing
                    ? "保存新版…"
                    : "检查下载…"}
            </BusyLabel>
          ) : downloading ? (
            "取消下载"
          ) : checkError ? (
            "检查失败，重试"
          ) : downloadStatus?.state === "complete" ? (
            openError ? (
              "重试打开"
            ) : (
              "本地阅读"
            )
          ) : task?.phase === "failed" ? (
            "重试下载"
          ) : task?.phase === "canceled" ? (
            "继续下载"
          ) : downloadStatus?.state === "partial" ? (
            "补全下载"
          ) : (
            "下载到 GRIP"
          )}
        </DialogButton>
        {downloading && (
          <div data-grip-download-progress="true" style={{ fontSize: 14 }}>
            {total > 0 && (
              <progress
                aria-label="离线图片下载进度"
                max={total}
                value={completed}
                style={{ width: "100%", accentColor: "#67c1f5" }}
              />
            )}
            <div role="status">{progressText}</div>
          </div>
        )}
        {!checking && !downloading && downloadStatus?.state === "complete" && (
          <div role="status" style={{ fontSize: 14 }}>
            正文和图片已完整离线，按 A 本地阅读
          </div>
        )}
        {checkError && (
          <div role="status" style={{ color: "#ffc582", fontSize: 14 }}>
            本地状态读取失败：{checkError}
          </div>
        )}
        {openError && (
          <div role="alert" style={{ color: "#ffc582", fontSize: 14 }}>
            本地阅读打开失败：{openError}
          </div>
        )}
        {(progress?.error || task?.error) && (
          <div
            role="status"
            style={{ color: "#ffc582", fontSize: 14, padding: "6px 0" }}
          >
            {progress?.stopped
              ? "已暂停："
              : progress?.failed
                ? `${progress.failed} 张图片失败：`
                : ""}
            {progress?.error ?? task?.error}
            {downloading && !progress?.stopped
              ? "；其余图片继续下载，完成后可重试失败图片。"
              : "；已下载内容保留。"}
          </div>
        )}
      </div>
    </NavigationProvider>,
    target.element,
  );
}

export function GuideDownloadButton({
  identity,
  ...props
}: GuideDownloadButtonProps) {
  return identity ? (
    <GuideDownloadButtonForGuide
      {...props}
      identity={identity}
      key={makeGuideKey(identity)}
    />
  ) : null;
}

export function NativeGuideDownloadButton({
  status,
  downloads,
  getDownloadStatus,
  openGuide,
}: NativeGuideDownloadButtonProps) {
  const runtimeStatus = useSyncExternalStore(
    status.subscribe,
    status.getSnapshot,
  );
  const identity = runtimeStatus.activeGuide;
  const target = useNativeGuideActionTarget(identity);
  return (
    <GuideDownloadButton
      downloads={downloads}
      getDownloadStatus={getDownloadStatus}
      openGuide={openGuide}
      identity={identity}
      revision={runtimeStatus.downloadRevision}
      target={target}
    />
  );
}
