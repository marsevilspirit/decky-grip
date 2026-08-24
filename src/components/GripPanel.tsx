import { PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

import { getPositionCount } from "../backend";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; count: number }
  | { kind: "error"; message: string };

export function GripPanel() {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let active = true;

    getPositionCount()
      .then((count) => {
        if (active) {
          setLoadState({ kind: "ready", count });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          const message =
            error instanceof Error ? error.message : "Unknown backend error";
          setLoadState({ kind: "error", message });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <PanelSection title="Guide resume">
      <PanelSectionRow>
        <div>
          {loadState.kind === "loading" && "Loading saved positions…"}
          {loadState.kind === "ready" &&
            `${loadState.count} saved guide position${loadState.count === 1 ? "" : "s"}`}
          {loadState.kind === "error" &&
            `Could not read saved positions: ${loadState.message}`}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ opacity: 0.72 }}>
          GRIP is being wired to Steam&apos;s native guide scroll history.
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}
