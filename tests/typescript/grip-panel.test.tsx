// @vitest-environment happy-dom

import {
  act,
  createElement,
  type ChangeEventHandler,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getHotkeyStatus,
  type CacheClearResult,
  type GuideLibraryEntry,
  type HotkeyStatus,
  type ReaderCacheStats,
} from "../../src/backend";
import { GripPanel } from "../../src/components/GripPanel";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import { RuntimeStatusStore } from "../../src/runtime-status";

const deckyApiMock = vi.hoisted(() => ({ quickAccessVisible: true }));

vi.mock("@decky/api", () => ({
  useQuickAccessVisible: () => deckyApiMock.quickAccessVisible,
}));

vi.mock("@decky/ui", () => {
  interface MockProps {
    checked?: boolean;
    children?: ReactNode;
    description?: ReactNode;
    disabled?: boolean;
    label?: ReactNode;
    onChange?:
      ChangeEventHandler<HTMLInputElement> | ((value: boolean) => void);
    onClick?: () => void;
    title?: ReactNode;
    value?: string;
  }

  return {
    ButtonItem: ({ children, disabled, label, onClick }: MockProps) =>
      createElement("button", { disabled, onClick }, label, children),
    PanelSection: ({ children, title }: MockProps) =>
      createElement("section", null, title, children),
    PanelSectionRow: ({ children }: MockProps) =>
      createElement("div", null, children),
    Spinner: () => createElement("span"),
    TextField: ({ label, onChange, value }: MockProps) =>
      createElement("input", {
        "aria-label": label,
        onChange: onChange as ChangeEventHandler<HTMLInputElement>,
        value,
      }),
    ToggleField: ({
      checked,
      description,
      disabled,
      label,
      onChange,
    }: MockProps) =>
      createElement(
        "button",
        {
          "aria-pressed": checked,
          disabled,
          onClick: () =>
            (onChange as ((value: boolean) => void) | undefined)?.(!checked),
        },
        label,
        description,
      ),
  };
});

vi.mock("../../src/backend", () => ({
  getHotkeyStatus: vi.fn(async (): Promise<HotkeyStatus> => ({
    available: false,
    button: "L4",
    device: null,
    running: true,
  })),
}));

const cacheStats: ReaderCacheStats = {
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
};

describe("GripPanel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const mount = async (
    options: {
      clearGuides?: () => Promise<CacheClearResult>;
      getCacheStats?: () => Promise<ReaderCacheStats>;
      guides?: GuideLibraryEntry[];
      repairPositions?: () => Promise<string>;
      status?: RuntimeStatusStore;
    } = {},
  ): Promise<void> => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <GripPanel
          cacheGuide={async () => {
            throw new Error("unused");
          }}
          clearGuides={
            options.clearGuides ??
            (async () => ({ bytesRemoved: 0, filesRemoved: 0 }))
          }
          clearImages={async () => ({ bytesRemoved: 0, filesRemoved: 0 })}
          getCacheStats={options.getCacheStats ?? (async () => cacheStats)}
          loadGuideLibrary={async () => options.guides ?? []}
          openGuide={async () => undefined}
          openReader={async () => undefined}
          performance={new ReaderPerformanceTracker()}
          removeGuideCache={async () => ({
            bytesRemoved: 0,
            filesRemoved: 0,
          })}
          repairPositions={options.repairPositions ?? (async () => "")}
          retryPositions={async () => true}
          status={options.status ?? new RuntimeStatusStore("1113000")}
        />,
      );
      await Promise.resolve();
    });
  };

  const button = (label: string): HTMLButtonElement => {
    const match = [...(container?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (!match) {
      throw new Error(`missing button: ${label}`);
    }
    return match;
  };

  const panelText = (): string => container?.textContent ?? "";

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    deckyApiMock.quickAccessVisible = true;
  });

  it("refreshes the hotkey status whenever quick access becomes visible", async () => {
    const status = new RuntimeStatusStore("1113000");
    const hotkeyStatus = vi.mocked(getHotkeyStatus);
    hotkeyStatus.mockClear();
    deckyApiMock.quickAccessVisible = false;
    await mount({ status });
    expect(hotkeyStatus).not.toHaveBeenCalled();

    await act(async () => {
      deckyApiMock.quickAccessVisible = true;
      status.update({ message: "visible" });
      await Promise.resolve();
    });
    expect(hotkeyStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      status.update({ message: "still visible" });
      await Promise.resolve();
    });
    expect(hotkeyStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      deckyApiMock.quickAccessVisible = false;
      status.update({ message: "hidden" });
      await Promise.resolve();
    });
    expect(hotkeyStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      deckyApiMock.quickAccessVisible = true;
      status.update({ message: "visible again" });
      await Promise.resolve();
    });
    expect(hotkeyStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a failed initial read and retries it", async () => {
    const getCacheStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce(cacheStats);
    await mount({ getCacheStats });

    await act(async () => {
      button("高级选项").click();
    });

    expect(panelText()).toContain("缓存用量读取失败：sidecar unavailable");

    await act(async () => {
      button("重试读取缓存用量").click();
      await Promise.resolve();
    });

    expect(getCacheStats).toHaveBeenCalledTimes(2);
    expect(panelText()).toContain("指南 2 个 / 1.0 KiB");
    expect(panelText()).not.toContain("缓存用量读取失败");
  });

  it("keeps the default guide actions compact and reveals maintenance controls", async () => {
    await mount({
      guides: [
        {
          appId: "1113000",
          guideId: "3414883877",
          updatedAt: 1,
          cache: {
            author: "测试作者",
            fetchedAt: 1,
            sectionTitle: null,
            stale: true,
            title: "完整攻略",
          },
        },
      ],
    });

    expect(panelText()).toContain("继续当前或最近指南");
    expect(panelText()).toContain("完整攻略");
    expect(panelText()).not.toContain("筛选指南");
    expect(panelText()).not.toContain("仅看收藏");
    expect(panelText()).not.toContain("清除指南正文缓存");
    expect(panelText()).not.toContain("更新离线指南");
    expect(panelText()).not.toContain("移除此指南的正文缓存");
    expect(panelText()).not.toContain("物理 L4 首屏门禁");

    await act(async () => {
      button("高级选项").click();
    });

    expect(panelText()).toContain("清除指南正文缓存");
    expect(panelText()).toContain("更新离线指南");
    expect(panelText()).toContain("移除此指南的正文缓存");
    expect(panelText()).toContain("物理 L4 首屏门禁");
  });

  it("keeps position repair feedback visible while advanced options are closed", async () => {
    const status = new RuntimeStatusStore("1113000");
    status.update({ positionWarning: "位置文件损坏" });
    await mount({
      repairPositions: async () => "损坏位置已备份并重置",
      status,
    });

    await act(async () => {
      button("备份并重置损坏位置").click();
      await Promise.resolve();
    });

    expect(panelText()).toContain("损坏位置已备份并重置");
    expect(panelText()).not.toContain("清除指南正文缓存");
  });

  it("keeps cache action feedback visible after advanced options close", async () => {
    let finishClear!: (result: CacheClearResult) => void;
    await mount({
      clearGuides: () =>
        new Promise((resolve) => {
          finishClear = resolve;
        }),
    });

    await act(async () => button("高级选项").click());
    await act(async () => button("清除指南正文缓存").click());
    expect(
      button("正在清除").querySelector('[data-grip-busy="true"]'),
    ).not.toBeNull();
    await act(async () => button("高级选项").click());
    await act(async () => {
      finishClear({ bytesRemoved: 1_024, filesRemoved: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(panelText()).not.toContain("清除指南正文缓存");
    expect(panelText()).toContain(
      "指南缓存已清除：删除 2 个文件，释放 1.0 KiB",
    );
  });

  it("clears the guide query when the app changes", async () => {
    const status = new RuntimeStatusStore("1113000");
    await mount({
      guides: [
        {
          appId: "1113000",
          guideId: "1",
          updatedAt: 2,
          cache: null,
        },
        {
          appId: "1113000",
          guideId: "2",
          updatedAt: 1,
          cache: null,
        },
      ],
      status,
    });
    const filter = container?.querySelector<HTMLInputElement>(
      'input[aria-label="筛选指南"]',
    );
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(filter, "攻略");
      filter?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(filter?.value).toBe("攻略");

    await act(async () => {
      status.setGuideLibraryAppId("222");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container?.querySelector<HTMLInputElement>('input[aria-label="筛选指南"]')
        ?.value,
    ).toBe("");
  });
});
