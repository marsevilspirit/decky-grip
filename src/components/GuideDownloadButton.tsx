import { Button } from "@decky/ui";
import { useRef, useState, useSyncExternalStore } from "react";

import type { DownloadedGuide } from "../reader/types";
import type { RuntimeStatusStore } from "../runtime-status";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

export interface GuideDownloadButtonProps {
  status: RuntimeStatusStore;
  downloadGuide: (
    identity: GuideIdentity,
  ) => Promise<Pick<DownloadedGuide, "stale">>;
}

type DownloadPhase = "downloading" | "cached" | "stale" | "failed";

interface DownloadState {
  guideKey: string;
  phase: DownloadPhase;
}

const LABELS: Record<DownloadPhase, string> = {
  downloading: "正在下载正文…",
  cached: "正文已缓存到 GRIP",
  stale: "已缓存到 GRIP（旧版）",
  failed: "下载失败，点击重试",
};

export function GuideDownloadButton({
  status,
  downloadGuide,
}: GuideDownloadButtonProps) {
  const activeGuide = useSyncExternalStore(
    status.subscribe,
    status.getSnapshot,
  ).activeGuide;
  const [downloadState, setDownloadState] = useState<DownloadState | null>(
    null,
  );
  const latestRequest = useRef<object | null>(null);

  if (!activeGuide) {
    return null;
  }

  const guideKey = makeGuideKey(activeGuide);
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
      const currentGuide = status.getSnapshot().activeGuide;
      setDownloadState(
        currentGuide !== null && makeGuideKey(currentGuide) === guideKey
          ? { guideKey, phase: nextPhase }
          : null,
      );
    };
    try {
      const guide = await downloadGuide(activeGuide);
      finish(guide.stale ? "stale" : "cached");
    } catch {
      finish("failed");
    }
  };

  return (
    <div
      aria-live="polite"
      style={{
        bottom: "96px",
        position: "fixed",
        right: "48px",
        width: "240px",
        zIndex: 1000,
      }}
    >
      <Button
        disabled={phase === "downloading"}
        onClick={() => void download()}
        style={{ width: "100%" }}
      >
        {phase ? LABELS[phase] : "下载正文到 GRIP"}
      </Button>
    </div>
  );
}
