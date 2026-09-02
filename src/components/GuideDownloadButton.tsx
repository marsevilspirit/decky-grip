import { DialogButton } from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { DownloadedGuide } from "../reader/types";
import type { RuntimeStatusStore } from "../runtime-status";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";
import {
  findNativeGuideActionTarget,
  type NativeGuideActionTarget,
} from "../steam/native-guide";

export interface GuideDownloadButtonProps {
  identity: GuideIdentity | null;
  target: NativeGuideActionTarget | null;
  downloadGuide: (
    identity: GuideIdentity,
  ) => Promise<Pick<DownloadedGuide, "stale">>;
}

export interface NativeGuideDownloadButtonProps {
  status: RuntimeStatusStore;
  downloadGuide: GuideDownloadButtonProps["downloadGuide"];
}

type DownloadPhase = "downloading" | "cached" | "stale" | "failed";

interface DownloadState {
  guideKey: string;
  phase: DownloadPhase;
}

const LABELS: Record<DownloadPhase, string> = {
  downloading: "下载中…",
  cached: "已下载",
  stale: "已下载（旧版）",
  failed: "重试下载",
};

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
}: Omit<GuideDownloadButtonProps, "identity"> & {
  identity: GuideIdentity;
}) {
  const [downloadState, setDownloadState] = useState<DownloadState | null>(
    null,
  );
  const latestRequest = useRef<object | null>(null);
  const guideKey = makeGuideKey(identity);
  const phase =
    downloadState?.guideKey === guideKey ? downloadState.phase : null;

  const download = async (): Promise<void> => {
    if (phase === "downloading") {
      return;
    }
    const request = {};
    latestRequest.current = request;
    setDownloadState({ guideKey, phase: "downloading" });
    const finish = (nextPhase: Exclude<DownloadPhase, "downloading">) => {
      if (latestRequest.current !== request) {
        return;
      }
      setDownloadState({ guideKey, phase: nextPhase });
    };
    try {
      const guide = await downloadGuide(identity);
      finish(guide.stale ? "stale" : "cached");
    } catch {
      finish("failed");
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
        disabled={phase === "downloading"}
        onClick={() => void download()}
      >
        {phase ? LABELS[phase] : "下载到 GRIP"}
      </DialogButton>
    </NavigationProvider>,
    target.element,
  );
}

export function GuideDownloadButton({
  identity,
  target,
  downloadGuide,
}: GuideDownloadButtonProps) {
  return identity ? (
    <GuideDownloadButtonForGuide
      downloadGuide={downloadGuide}
      identity={identity}
      key={makeGuideKey(identity)}
      target={target}
    />
  ) : null;
}

export function NativeGuideDownloadButton({
  status,
  downloadGuide,
}: NativeGuideDownloadButtonProps) {
  const identity = useSyncExternalStore(
    status.subscribe,
    status.getSnapshot,
  ).activeGuide;
  const target = useNativeGuideActionTarget(identity);
  return (
    <GuideDownloadButton
      downloadGuide={downloadGuide}
      identity={identity}
      target={target}
    />
  );
}
