import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

import { getHotkeyStatus, type HotkeyStatus } from "../backend";
import type { GripRuntimeStatus, RuntimeStatusStore } from "../runtime-status";

export interface GripPanelProps {
  status: RuntimeStatusStore;
  openReader: () => Promise<void>;
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

export function GripPanel({ status: statusStore, openReader }: GripPanelProps) {
  const [status, setStatus] = useState(statusStore.getSnapshot);
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);

  useEffect(() => {
    setStatus(statusStore.getSnapshot());
    return statusStore.subscribe(() => setStatus(statusStore.getSnapshot()));
  }, [statusStore]);

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

  const lastAction = describeLastAction(status);

  return (
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
