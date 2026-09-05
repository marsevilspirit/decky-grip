import { DialogButton } from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { GuideDownloadStatus } from "../backend";
import type { DownloadedGuide } from "../reader/types";
import type { GuideImageDownloadProgress } from "../reader/download";
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
  downloadGuide: (
    identity: GuideIdentity,
    onProgress?: (progress: GuideImageDownloadProgress) => void,
  ) => Promise<Pick<DownloadedGuide, "stale">>;
}

export interface NativeGuideDownloadButtonProps {
  status: RuntimeStatusStore;
  downloadGuide: GuideDownloadButtonProps["downloadGuide"];
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
  downloadGuide,
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
  const [operation, setOperation] = useState<"download" | "open" | null>(null);
  const [failedOperation, setFailedOperation] =
    useState<typeof operation>(null);
  const [progress, setProgress] = useState<GuideImageDownloadProgress | null>(
    null,
  );
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (operation !== null) return;
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
  }, [getDownloadStatus, identity.guideId, revision, checkRevision, operation]);

  const activate = async (): Promise<void> => {
    if (busyRef.current || checking) return;
    if (checkFailed || !downloadStatus) {
      setCheckRevision((value) => value + 1);
      return;
    }
    const nextOperation =
      downloadStatus.state === "complete" ? "open" : "download";
    busyRef.current = true;
    setOperation(nextOperation);
    setFailedOperation(null);
    setProgress(null);
    try {
      if (nextOperation === "open") {
        await openGuide(identity);
      } else {
        await downloadGuide(identity, (nextProgress) => {
          if (mountedRef.current) setProgress(nextProgress);
        });
      }
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
        disabled={operation !== null || checking}
        onClick={() => void activate()}
      >
        {operation !== null || checking ? (
          <BusyLabel>
            {operation === "open"
              ? "正在打开…"
              : operation === "download"
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
        ) : failedOperation === "download" ? (
          "重试下载"
        ) : downloadStatus?.state === "partial" ? (
          "补全下载"
        ) : (
          "下载到 GRIP"
        )}
      </DialogButton>
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
  downloadGuide,
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
      downloadGuide={downloadGuide}
      getDownloadStatus={getDownloadStatus}
      openGuide={openGuide}
      identity={identity}
      revision={runtimeStatus.downloadRevision}
      target={target}
    />
  );
}
