import { PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

import type { GripRuntimeStatus, RuntimeStatusStore } from "../runtime-status";

export interface GripPanelProps {
  status: RuntimeStatusStore;
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

export function GripPanel({ status: statusStore }: GripPanelProps) {
  const [status, setStatus] = useState(statusStore.getSnapshot);

  useEffect(() => {
    setStatus(statusStore.getSnapshot());
    return statusStore.subscribe(() => setStatus(statusStore.getSnapshot()));
  }, [statusStore]);

  const lastAction = describeLastAction(status);

  return (
    <PanelSection title="Guide resume">
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
  );
}
