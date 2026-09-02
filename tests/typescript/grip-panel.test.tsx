// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GripPanel } from "../../src/components/GripPanel";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import { RuntimeStatusStore } from "../../src/runtime-status";

vi.mock("@decky/api", () => ({
  useQuickAccessVisible: () => true,
}));

vi.mock("@decky/ui", () => {
  interface MockProps {
    children?: ReactNode;
    disabled?: boolean;
    label?: ReactNode;
    onClick?: () => void;
    title?: ReactNode;
  }

  return {
    ButtonItem: ({ children, disabled, label, onClick }: MockProps) =>
      createElement("button", { disabled, onClick }, label, children),
    PanelSection: ({ children, title }: MockProps) =>
      createElement("section", null, title, children),
    PanelSectionRow: ({ children }: MockProps) =>
      createElement("div", null, children),
    TextField: () => null,
    ToggleField: () => null,
  };
});

vi.mock("../../src/backend", () => ({
  getHotkeyStatus: async () => ({
    available: false,
    button: "L4",
    device: null,
    running: true,
  }),
  setGuideFavorite: vi.fn(),
}));

describe("GripPanel cache statistics", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("shows a failed initial read and retries it", async () => {
    const getCacheStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce({
        guides: {
          files: 2,
          bytes: 1_024,
          diskLimitBytes: 2_048,
          memoryEntries: 1,
          memoryBytes: 512,
          memoryLimitBytes: 1_024,
        },
        images: {
          files: 3,
          diskBytes: 4_096,
          diskLimitBytes: 8_192,
          memoryEntries: 1,
          memoryBytes: 512,
          memoryLimitBytes: 1_024,
        },
      });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <GripPanel
          cacheGuide={async () => {
            throw new Error("unused");
          }}
          clearGuides={async () => ({ bytesRemoved: 0, filesRemoved: 0 })}
          clearImages={async () => ({ bytesRemoved: 0, filesRemoved: 0 })}
          getCacheStats={getCacheStats}
          loadGuideLibrary={async () => []}
          openGuide={async () => undefined}
          openReader={async () => undefined}
          openSteamGuides={async () => undefined}
          performance={new ReaderPerformanceTracker()}
          removeGuideCache={async () => ({
            bytesRemoved: 0,
            filesRemoved: 0,
          })}
          repairPositions={async () => ""}
          retryPositions={async () => true}
          status={new RuntimeStatusStore()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "缓存用量读取失败：sidecar unavailable",
    );
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("重试读取缓存用量"),
    );
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(getCacheStats).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("指南 2 个 / 1.0 KiB");
    expect(container.textContent).not.toContain("缓存用量读取失败");
  });
});
