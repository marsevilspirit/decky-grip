// @vitest-environment happy-dom

import { showModal, type ConfirmModalProps } from "@decky/ui";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGuideLibrary,
  getHotkeyStatus,
  type CacheClearResult,
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
    onChange?: (value: boolean) => void;
    onClick?: () => void;
    title?: ReactNode;
  }

  return {
    gamepadDialogClasses: { FieldDescription: "native-field-description" },
    ConfirmModal: () => null,
    showModal: vi.fn(() => ({ Close: vi.fn(), Update: vi.fn() })),
    DropdownItem: ({
      label,
      disabled,
      selectedOption,
      rgOptions,
      onChange,
    }: {
      label: ReactNode;
      disabled: boolean;
      selectedOption: number;
      rgOptions: Array<{ data: number; label: string }>;
      onChange: (option: { data: number }) => void;
    }) =>
      createElement(
        "select",
        {
          "aria-label": "图片离线额度",
          disabled,
          value: selectedOption,
          onChange: (event: { target: { value: string } }) =>
            onChange({ data: Number(event.target.value) }),
        },
        createElement("option", { value: selectedOption }, label),
        ...rgOptions.map((option) =>
          createElement(
            "option",
            { key: option.data, value: option.data },
            option.label,
          ),
        ),
      ),
    ButtonItem: ({
      children,
      description,
      disabled,
      label,
      onClick,
    }: MockProps) =>
      createElement(
        "div",
        { "data-native-button-item": true },
        label &&
          createElement("div", { "data-native-field-label": true }, label),
        description &&
          createElement(
            "div",
            { "data-native-field-description": true },
            description,
          ),
        createElement("button", { disabled, onClick }, children),
      ),
    PanelSection: ({ children, title }: MockProps) =>
      createElement("section", null, title, children),
    PanelSectionRow: ({ children }: MockProps) =>
      createElement("div", { "data-native-panel-row": true }, children),
    Spinner: () => createElement("span"),
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
  getGuideLibrary: vi.fn(async () => []),
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
    offlineBytes: 2_048,
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
      clearImages?: () => Promise<CacheClearResult>;
      getCacheStats?: () => Promise<ReaderCacheStats>;
      setImageLimit?: (bytes: number) => Promise<ReaderCacheStats["images"]>;
      openReader?: () => Promise<void>;
      openImport?: () => Promise<void>;
      repairPositions?: () => Promise<string>;
      retryPositions?: () => Promise<boolean>;
      status?: RuntimeStatusStore;
    } = {},
  ): Promise<void> => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <GripPanel
          clearGuides={
            options.clearGuides ??
            (async () => ({ bytesRemoved: 0, filesRemoved: 0 }))
          }
          clearImages={
            options.clearImages ??
            (async () => ({ bytesRemoved: 0, filesRemoved: 0 }))
          }
          getCacheStats={options.getCacheStats ?? (async () => cacheStats)}
          setImageLimit={
            options.setImageLimit ?? (async () => cacheStats.images)
          }
          openReader={options.openReader ?? (async () => undefined)}
          openImport={options.openImport}
          performance={new ReaderPerformanceTracker()}
          repairPositions={options.repairPositions ?? (async () => "")}
          retryPositions={options.retryPositions ?? (async () => true)}
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
  const confirmation = (): ConfirmModalProps =>
    (vi.mocked(showModal).mock.lastCall![0] as ReactElement<ConfirmModalProps>)
      .props;

  it("saves an offline quota choice and shows a failed shrink without clearing downloads", async () => {
    const setImageLimit = vi.fn(async () => {
      throw new Error("新额度小于已下载图片用量");
    });
    const clearGuides = vi.fn(async () => ({
      filesRemoved: 0,
      bytesRemoved: 0,
    }));
    await mount({ setImageLimit, clearGuides });
    await act(async () => button("高级选项").click());
    const select = container!.querySelector("select")!;
    await act(async () => {
      select.value = String(64 * 1024 * 1024);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setImageLimit).toHaveBeenCalledExactlyOnceWith(64 * 1024 * 1024);
    expect(panelText()).toContain("新额度小于已下载图片用量");
    expect(clearGuides).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    deckyApiMock.quickAccessVisible = true;
    vi.mocked(getGuideLibrary).mockClear();
    vi.mocked(showModal).mockClear();
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

  it("reads cache usage only while advanced quick access is visible and rejects outdated responses", async () => {
    const status = new RuntimeStatusStore("1113000");
    const finish: Array<(stats: ReaderCacheStats) => void> = [];
    const getCacheStats = vi.fn(
      () => new Promise<ReaderCacheStats>((resolve) => finish.push(resolve)),
    );
    deckyApiMock.quickAccessVisible = false;
    await mount({ status, getCacheStats });
    await act(async () => button("高级选项").click());
    expect(getCacheStats).not.toHaveBeenCalled();
    await act(async () => {
      deckyApiMock.quickAccessVisible = true;
      status.update({ message: "visible" });
    });
    expect(getCacheStats).toHaveBeenCalledTimes(1);
    await act(async () => status.refreshDownloads());
    expect(getCacheStats).toHaveBeenCalledTimes(2);
    const newerStats = {
      ...cacheStats,
      guides: { ...cacheStats.guides, files: 7 },
    };
    await act(async () => finish[1](newerStats));
    await act(async () => finish[0](cacheStats));
    expect(panelText()).toContain("指南 7 个");
    expect(panelText()).not.toContain("指南 2 个");
    await act(async () => {
      deckyApiMock.quickAccessVisible = false;
      status.refreshDownloads();
    });
    expect(getCacheStats).toHaveBeenCalledTimes(2);
    await act(async () => {
      deckyApiMock.quickAccessVisible = true;
      status.update({ message: "visible again" });
    });
    expect(getCacheStats).toHaveBeenCalledTimes(3);
    await act(async () => button("高级选项").click());
    await act(async () => status.refreshDownloads());
    await act(async () => finish[2](cacheStats));
    expect(getCacheStats).toHaveBeenCalledTimes(3);
    await act(async () => button("高级选项").click());
    expect(panelText()).toContain("指南 7 个");
    expect(getCacheStats).toHaveBeenCalledTimes(4);
    await act(async () => root?.unmount());
    root = null;
    await act(async () => finish[3](cacheStats));
    expect(container?.childElementCount).toBe(0);
  });

  it("requires a native destructive confirmation, supports cancel and prevents duplicate clears", async () => {
    let finishClear!: (result: CacheClearResult) => void;
    const clearGuides = vi.fn(
      () =>
        new Promise<CacheClearResult>((resolve) => {
          finishClear = resolve;
        }),
    );
    const clearImages = vi.fn(async () => ({
      filesRemoved: 0,
      bytesRemoved: 0,
    }));
    await mount({ clearGuides, clearImages });
    await act(async () => button("高级选项").click());
    await act(async () => {
      button("清除指南正文缓存").click();
      button("清除指南正文缓存").click();
    });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(clearGuides).not.toHaveBeenCalled();
    const canceled = confirmation();
    expect(canceled.bDestructiveWarning).toBe(true);
    expect(canceled.strDescription).toContain("已下载指南");
    expect(canceled.strCancelButtonText).toBe("保留，返回");
    await act(async () => {
      canceled.onCancel?.();
      canceled.onOK?.();
    });
    expect(clearGuides).not.toHaveBeenCalled();
    expect(
      vi.mocked(showModal).mock.results[0].value.Close,
    ).toHaveBeenCalledOnce();
    await act(async () => button("清除指南正文缓存").click());
    const accepted = confirmation();
    await act(async () => {
      accepted.onOK?.();
      accepted.onOK?.();
      button("清除图片缓存").click();
    });
    expect(clearGuides).toHaveBeenCalledOnce();
    expect(clearImages).not.toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledTimes(2);
    await act(async () =>
      finishClear({ filesRemoved: 2, bytesRemoved: 1_024 }),
    );
    expect(panelText()).toContain(
      "指南缓存已清除：删除 2 个文件，释放 1.0 KiB",
    );
    await act(async () => button("清除图片缓存").click());
    expect(confirmation().strDescription).toContain("离线下载的图片");
    await act(async () => confirmation().onOK?.());
    expect(clearImages).toHaveBeenCalledOnce();
  });

  it("finishes cache-action feedback without waiting for stats and invalidates pre-action reads", async () => {
    let finishOldStats!: (stats: ReaderCacheStats) => void;
    let finishNewStats!: (stats: ReaderCacheStats) => void;
    let finishClear!: (result: CacheClearResult) => void;
    const getCacheStats = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReaderCacheStats>((resolve) => {
            finishOldStats = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ReaderCacheStats>((resolve) => {
            finishNewStats = resolve;
          }),
      );
    const openReader = vi.fn(async () => undefined);
    await mount({
      getCacheStats,
      openReader,
      clearGuides: () =>
        new Promise((resolve) => {
          finishClear = resolve;
        }),
    });
    await act(async () => button("高级选项").click());
    await act(async () => button("清除指南正文缓存").click());
    await act(async () => confirmation().onOK?.());
    await act(async () => finishOldStats(cacheStats));
    expect(panelText()).not.toContain("指南 2 个");
    expect(button("继续当前或最近指南").disabled).toBe(true);
    await act(async () =>
      finishClear({ bytesRemoved: 1_024, filesRemoved: 2 }),
    );
    expect(getCacheStats).toHaveBeenCalledTimes(2);
    expect(panelText()).toContain("指南缓存已清除：删除 2 个文件");
    expect(button("清除指南正文缓存").disabled).toBe(false);
    expect(button("继续当前或最近指南").disabled).toBe(false);
    await act(async () => button("继续当前或最近指南").click());
    expect(openReader).toHaveBeenCalledOnce();
    await act(async () =>
      finishNewStats({
        ...cacheStats,
        guides: { ...cacheStats.guides, files: 0 },
      }),
    );
    expect(panelText()).toContain("指南 0 个");
  });

  it("closes confirmations on unmount and ignores their stale confirm callbacks", async () => {
    const clearImages = vi.fn(async () => ({
      filesRemoved: 0,
      bytesRemoved: 0,
    }));
    await mount({ clearImages });
    await act(async () => button("高级选项").click());
    await act(async () => button("清除图片缓存").click());
    const pending = confirmation();
    await act(async () => root?.unmount());
    root = null;
    expect(
      vi.mocked(showModal).mock.results[0].value.Close,
    ).toHaveBeenCalledOnce();
    await act(async () => pending.onOK?.());
    expect(clearImages).not.toHaveBeenCalled();
  });

  it("keeps the default guide actions compact and reveals maintenance controls", async () => {
    await mount();

    expect(panelText()).toContain("继续当前或最近指南");
    expect(container?.querySelectorAll("button")).toHaveLength(2);
    expect(panelText()).not.toContain("筛选指南");
    expect(panelText()).not.toContain("仅看收藏");
    expect(panelText()).not.toContain("清除指南正文缓存");
    expect(panelText()).not.toContain("更新离线指南");
    expect(panelText()).not.toContain("移除此指南的正文缓存");
    expect(panelText()).not.toContain("L4 检测后首屏门禁");

    await act(async () => {
      button("高级选项").click();
    });

    expect(panelText()).toContain("清除指南正文缓存");
    expect(panelText()).not.toContain("更新离线指南");
    expect(panelText()).not.toContain("移除此指南的正文缓存");
    expect(panelText()).toContain("L4 检测后首屏门禁");
    expect(panelText()).toContain("从后端读到 L4 开始计时");
  });

  it("puts every QAM action in its own row with a short button and a separate native description", async () => {
    const status = new RuntimeStatusStore("1113000");
    status.update({ positionWarning: "位置文件损坏" });
    await mount({
      status,
      openImport: async () => {},
      getCacheStats: async () => {
        throw new Error("统计暂不可用");
      },
    });
    await act(async () => button("高级选项").click());
    const descriptions = new Map([
      ["导入攻略", "从小黑盒分享链接保存完整离线图文"],
      ["继续当前或最近指南", "优先继续当前游戏正在查看的指南"],
      ["重试读取位置", "不会影响已缓存的指南正文"],
      ["备份并重置损坏位置", "仅在校验失败时备份原文件并重置"],
      ["重试读取缓存用量", "仅重新读取统计，不会修改缓存或阅读位置"],
      ["清除指南正文缓存", "包括已下载正文；保留阅读位置，下次需要联网下载"],
      ["清除图片缓存", "包括离线图片；正文和阅读位置保留"],
    ]);
    const items = [...container!.querySelectorAll("[data-native-button-item]")];
    expect(items).toHaveLength(descriptions.size);
    for (const item of items) {
      const action = item.querySelector("button")!;
      const description = item.querySelector(
        "[data-native-field-description]",
      )!;
      expect(descriptions.has(action.textContent!)).toBe(true);
      expect(description.textContent).toBe(
        descriptions.get(action.textContent!),
      );
      expect(action.textContent).not.toContain(description.textContent!);
      expect(item.querySelector("[data-native-field-label]")).toBeNull();
      expect(item.parentElement?.hasAttribute("data-native-panel-row")).toBe(
        true,
      );
      expect(
        item.parentElement?.querySelectorAll("[data-native-button-item]"),
      ).toHaveLength(1);
    }
  });

  it("keeps reader opening feedback and allows retry after a failed open", async () => {
    let finishOpen!: () => void;
    const openReader = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOpen = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("打开失败"));
    await mount({ openReader });

    await act(async () => {
      button("继续当前或最近指南").click();
      button("继续当前或最近指南").click();
    });
    const opening = button("正在打开 GRIP 阅读器");
    expect(opening.disabled).toBe(true);
    expect(opening.querySelector('[data-grip-busy="true"]')).not.toBeNull();
    await act(async () => opening.click());
    expect(openReader).toHaveBeenCalledTimes(1);

    await act(async () => finishOpen());
    expect(button("继续当前或最近指南").disabled).toBe(false);

    await act(async () => button("继续当前或最近指南").click());
    expect(panelText()).toContain("打开失败");
    expect(button("继续当前或最近指南").disabled).toBe(false);
  });

  it("immediately acknowledges import opening, prevents duplicate actions and allows a clean retry", async () => {
    let failOpen!: (error: Error) => void;
    let finishRetry!: () => void;
    const openImport = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (failOpen = reject)),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishRetry = resolve)),
      );
    const openReader = vi.fn(async () => undefined);
    await mount({ openImport, openReader });
    await act(async () => button("高级选项").click());
    const trigger = button("导入攻略");
    await act(async () => {
      trigger.click();
      trigger.click();
      button("继续当前或最近指南").click();
      button("清除图片缓存").click();
    });
    const pending = button("正在打开导入窗口");
    expect(pending).toBe(trigger);
    expect(pending.disabled).toBe(true);
    expect(pending.querySelector('[data-grip-busy="true"]')).not.toBeNull();
    expect(button("继续当前或最近指南").disabled).toBe(true);
    expect(openImport).toHaveBeenCalledOnce();
    expect(openReader).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    await act(async () => failOpen(new Error("读取游戏列表失败")));
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "读取游戏列表失败",
    );
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(openImport).toHaveBeenCalledTimes(2);
    await act(async () => finishRetry());
    expect(button("导入攻略").disabled).toBe(false);
    expect(button("继续当前或最近指南").disabled).toBe(false);
    expect(panelText()).not.toContain("正在打开导入窗口");
  });

  it.each(["resolve", "reject"])(
    "ignores an import opening %s after the panel unmounts",
    async (result) => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const openImport = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      await mount({ openImport });
      await act(async () => button("导入攻略").click());
      expect(openImport).toHaveBeenCalledOnce();
      await act(async () => root?.unmount());
      root = null;
      await act(async () => {
        if (result === "resolve") finish();
        else fail(new Error("迟到的打开失败"));
      });
      expect(container?.childElementCount).toBe(0);
    },
  );

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

  it("reports retry failures and prevents same-tick duplicate position operations", async () => {
    let failRetry!: (error: unknown) => void;
    const retryPositions = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          failRetry = reject;
        }),
    );
    const repairPositions = vi.fn(async () => "损坏位置已备份并重置");
    const status = new RuntimeStatusStore("1113000");
    status.update({ positionWarning: "位置文件损坏" });
    await mount({ status, retryPositions, repairPositions });
    await act(async () => {
      button("重试读取位置").click();
      button("重试读取位置").click();
      button("备份并重置损坏位置").click();
    });
    expect(retryPositions).toHaveBeenCalledOnce();
    expect(repairPositions).not.toHaveBeenCalled();
    await act(async () => failRetry(new Error("disk unavailable")));
    expect(panelText()).toContain("位置恢复失败：disk unavailable");
    expect(button("重试读取位置").disabled).toBe(false);
    await act(async () => button("备份并重置损坏位置").click());
    expect(panelText()).toContain("损坏位置已备份并重置");
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
    await act(async () => confirmation().onOK?.());
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

  it("does not load or display a guide library in normal, advanced, or global views", async () => {
    const status = new RuntimeStatusStore("1113000");
    vi.mocked(getGuideLibrary).mockResolvedValue([
      {
        appId: "1113000",
        guideId: "1",
        updatedAt: 2,
        cache: {
          author: "测试作者",
          fetchedAt: 1,
          sectionTitle: null,
          stale: false,
          title: "已下载的完整攻略",
        },
      },
    ]);
    status.seedRecentGuides([
      { identity: { appId: "1113000", guideId: "1" }, updatedAt: 2 },
    ]);
    await mount({ status });
    const expectNoGuideList = () => {
      expect(getGuideLibrary).not.toHaveBeenCalled();
      expect(container?.querySelector("input")).toBeNull();
      expect(panelText()).not.toContain("指南库");
      expect(panelText()).not.toContain("已下载的完整攻略");
      expect(panelText()).not.toContain("正在读取最近指南");
      expect(panelText()).not.toContain("筛选指南");
      expect(panelText()).not.toContain("补全离线下载");
      expect(panelText()).not.toContain("移除此指南的正文缓存");
    };
    expectNoGuideList();

    await act(async () => button("高级选项").click());
    expectNoGuideList();

    await act(async () => {
      status.setGuideLibraryAppId(null);
      status.refreshGuideLibrary();
      await Promise.resolve();
    });
    expectNoGuideList();
    expect(status.getRecentGuide("1113000")).toEqual({
      appId: "1113000",
      guideId: "1",
    });
  });
});
