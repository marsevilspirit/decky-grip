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
  const [checkFailed, setCheckFailed] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [operation, setOperation] = useState<"open" | null>(null);
  const [failedOperation, setFailedOperation] =
    useState<typeof operation>(null);
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
    setCheckFailed(false);
    void getDownloadStatus(identity.guideId)
      .then((status) => {
        if (!canceled && !busyRef.current) setDownloadStatus(status);
      })
      .catch(() => {
        if (!canceled && !busyRef.current) setCheckFailed(true);
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
    if (busyRef.current || checking || downloading) return;
    if (checkFailed || !downloadStatus) {
      setCheckRevision((value) => value + 1);
      return;
    }
    if (downloadStatus.state !== "complete") {
      void downloads.start(identity);
      return;
    }
    const nextOperation = "open";
    busyRef.current = true;
    setOperation(nextOperation);
    setFailedOperation(null);
    try {
      await openGuide(identity);
    } catch {
      if (mountedRef.current) setFailedOperation(nextOperation);
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
  return createPortal(
    <NavigationProvider value={target.navigationNode}>
      <DialogButton
        aria-live="polite"
        data-grip-guide-download="true"
        disabled={operation !== null || checking || downloading}
        onClick={() => void activate()}
      >
        {operation !== null || checking || downloading ? (
          <BusyLabel>
            {operation === "open"
              ? "正在打开…"
              : task?.phase === "canceling"
                ? "正在停止下载…"
                : downloading
                  ? progress
                    ? `图片 ${progress.completed}/${progress.total}…`
                    : "下载中…"
                  : "检查下载…"}
          </BusyLabel>
        ) : checkFailed ? (
          "检查失败，重试"
        ) : downloadStatus?.state === "complete" ? (
          failedOperation === "open" ? (
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
        <DialogButton
          disabled={task?.phase === "canceling"}
          onClick={() => downloads.cancel(identity.guideId)}
        >
          取消下载
        </DialogButton>
      )}
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
