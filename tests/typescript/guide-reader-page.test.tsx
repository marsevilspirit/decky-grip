// @vitest-environment happy-dom

import { act, createElement, type ChangeEventHandler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as DeckyUI from "@decky/ui";

import type { CacheClearResult, GuideLibraryEntry } from "../../src/backend";
import { GuideReaderPage } from "../../src/components/GuideReaderPage";
import { extractHeyboxArticle } from "../../src/import/heybox";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import {
  GuideDownloadTasks,
  type GuideImageDownloadProgress,
} from "../../src/reader/download";
import {
  ReaderImageHydrator,
  type GuideImageFetcher,
} from "../../src/reader/image-hydrator";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import {
  ReaderSessionCache,
  type ReaderSessionBackend,
} from "../../src/reader/session-cache";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";
import { GamepadButton, gamepadEvent } from "./helpers/decky-gamepad";
import type { MockDeckyProps as MockProps } from "./helpers/decky-ui";

vi.mock("@decky/ui", async () => {
  const { GamepadButton } = await import("./helpers/decky-gamepad");
  const { mockDeckyElement } = await import("./helpers/decky-ui");
  const keyboard = (props: MockProps) => {
    const onCancel = props.onCancel as
      ((event: CustomEvent) => void) | undefined;
    const onOptionsButton = props.onOptionsButton as
      | ((event: {
          detail: { button: number; is_repeat: boolean; source: number };
          preventDefault(): void;
          stopPropagation(): void;
        }) => void)
      | undefined;
    const onOKButton = props.onOKButton as typeof onOptionsButton;
    const onSecondaryButton = props.onSecondaryButton as typeof onOptionsButton;
    const onButtonDown = props.onButtonDown as typeof onOptionsButton;
    const onKeyDown = props.onKeyDown as
      ((event: KeyboardEvent) => void) | undefined;
    const onGamepadDirection =
      props.onGamepadDirection as typeof onOptionsButton;
    if (
      onCancel ||
      onOptionsButton ||
      onOKButton ||
      onGamepadDirection ||
      onSecondaryButton ||
      onButtonDown
    ) {
      return {
        onKeyDown: (event: KeyboardEvent) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          const gamepadEvent = (button: number) => ({
            target: event.target,
            detail: { button, is_repeat: event.repeat, source: 0 },
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
          });
          if (event.key === "Options" && onOptionsButton) {
            onOptionsButton(gamepadEvent(GamepadButton.OPTIONS));
          } else if (event.key === "Escape" && onCancel) {
            onCancel(event as unknown as CustomEvent);
          } else if (event.key === "Enter" && onOKButton) {
            onOKButton(gamepadEvent(GamepadButton.OK));
          } else if (event.key === "Secondary" && onSecondaryButton) {
            onSecondaryButton(gamepadEvent(GamepadButton.SECONDARY));
          } else if (event.key.startsWith("Arrow") && onGamepadDirection) {
            onGamepadDirection(
              gamepadEvent(
                {
                  ArrowUp: GamepadButton.DIR_UP,
                  ArrowDown: GamepadButton.DIR_DOWN,
                  ArrowLeft: GamepadButton.DIR_LEFT,
                  ArrowRight: GamepadButton.DIR_RIGHT,
                }[event.key] ?? GamepadButton.INVALID,
              ),
            );
          } else if (event.key === "BumperLeft" && onButtonDown) {
            onButtonDown(gamepadEvent(GamepadButton.BUMPER_LEFT));
          } else if (event.key === "BumperRight" && onButtonDown) {
            onButtonDown(gamepadEvent(GamepadButton.BUMPER_RIGHT));
          } else if (event.key === "TriggerRight" && onButtonDown) {
            onButtonDown(gamepadEvent(GamepadButton.TRIGGER_RIGHT));
          } else if (event.key === "TriggerLeft" && onButtonDown) {
            onButtonDown(gamepadEvent(GamepadButton.TRIGGER_LEFT));
          }
        },
      };
    }
    return {};
  };

  return {
    DialogButton: mockDeckyElement("button", keyboard),
    DialogHeader: mockDeckyElement("div"),
    DialogBodyText: mockDeckyElement("div"),
    gamepadDialogClasses: {
      GamepadDialogContent: "steam-dialog-content",
      FieldDescription: "steam-field-description",
    },
    Focusable: mockDeckyElement("div", keyboard),
    GamepadButton,
    Spinner: () => createElement("span"),
    TextField: ({ label, onChange, value }: MockProps) =>
      createElement("input", {
        "aria-label": label as string,
        onChange: onChange as ChangeEventHandler<HTMLInputElement>,
        value: value as string,
      }),
    ToggleField: ({ checked, label, onChange }: MockProps) =>
      createElement(
        "button",
        {
          "aria-pressed": checked as boolean,
          onClick: () =>
            (onChange as (nextValue: boolean) => void)(!(checked as boolean)),
        },
        label as string,
      ),
    useParams: () => ({ appId: "1113000", guideId: "3414883877" }),
  };
});

const identity = { appId: "1113000", guideId: "3414883877" };
const savedPosition: ReaderPosition = {
  scrollTop: 8_800,
  sectionId: "40",
  anchorText: "重复锚点",
  anchorOffset: 200,
  updatedAt: 1,
};

function guideFixture(): DownloadedGuide {
  return {
    guideId: identity.guideId,
    title: "组件回归指南",
    author: "测试作者",
    sourceUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${identity.guideId}`,
    fetchedAt: 1,
    fromCache: true,
    stale: false,
    sections: Array.from({ length: 50 }, (_, index) => {
      const number = index + 1;
      const html =
        number === 1 || number === 40
          ? "<p>重复锚点</p>"
          : number === 20
            ? '<p>图片章节前文 <strong>精准</strong>命中 中段 精准命中 后文</p><img data-grip-image-url="https://images.steamusercontent.com/ugc/test/image.png">'
            : `<p>正文 ${number}</p>`;
      return { id: String(number), title: `章节 ${number}`, html };
    }),
  };
}

describe("GuideReaderPage position lifecycle", () => {
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrame: number;
  let resizeCallbacks: Set<ResizeObserverCallback>;
  let textSections: WeakMap<Node, number>;
  let searchLayoutShift: number;
  let activeScroller: HTMLElement | null;
  let root: Root | null;
  let container: HTMLDivElement | null;

  beforeEach(() => {
    vi.useFakeTimers();
    animationFrames = new Map();
    nextAnimationFrame = 1;
    resizeCallbacks = new Set();
    textSections = new WeakMap();
    searchLayoutShift = 0;
    activeScroller = null;
    root = null;
    container = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextAnimationFrame++;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      animationFrames.delete(id);
    });
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {
          resizeCallbacks.add(callback);
        }

        observe(): void {}

        unobserve(): void {}

        disconnect(): void {
          resizeCallbacks.delete(this.callback);
        }
      },
    );
    vi.spyOn(document, "createRange").mockImplementation(() => {
      let selected: Node | null = null;
      let rangeStart: Node | null = null;
      let rangeStartOffset = 0;
      let rangeEnd: Node | null = null;
      let rangeEndOffset = 0;
      return {
        get endContainer() {
          return rangeEnd ?? selected ?? document;
        },
        get endOffset() {
          return rangeEndOffset;
        },
        get startContainer() {
          return rangeStart ?? selected ?? document;
        },
        get startOffset() {
          return rangeStartOffset;
        },
        selectNodeContents(node: Node) {
          selected = node;
        },
        setEnd(node: Node, offset: number) {
          rangeEnd = node;
          rangeEndOffset = offset;
        },
        setStart(node: Node, offset: number) {
          rangeStart = node;
          rangeStartOffset = offset;
        },
        getBoundingClientRect() {
          const point = rangeStart ?? selected;
          const parent =
            point instanceof Element ? point : (point?.parentElement ?? null);
          const sectionId = Number(
            parent?.closest<HTMLElement>("[data-guide-section-id]")?.dataset
              .guideSectionId ?? (point ? textSections.get(point) : 0),
          );
          const absoluteTop =
            sectionId === 40
              ? 9_000
              : sectionId * 200 + rangeStartOffset * 10 + searchLayoutShift;
          const top = absoluteTop - (activeScroller?.scrollTop ?? 0);
          return {
            bottom: top + 20,
            height: 20,
            left: 0,
            right: 800,
            top,
            width: 800,
            x: 0,
            y: top,
            toJSON: () => ({}),
          };
        },
      } as Range;
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const flushFrame = async (): Promise<void> => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    await act(async () => {
      for (const callback of callbacks) {
        callback(performance.now());
      }
      await Promise.resolve();
    });
    indexTextSections();
  };

  const indexTextSections = (): void => {
    for (const section of document.querySelectorAll<HTMLElement>(
      "[data-guide-section-id]",
    )) {
      const sectionId = Number(section.dataset.guideSectionId);
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        textSections.set(node, sectionId);
      }
    }
  };

  const notifyResize = (): void => {
    act(() => {
      for (const callback of [...resizeCallbacks]) {
        callback([], {} as ResizeObserver);
      }
    });
  };

  const mount = async (
    cache: ReaderSessionCache,
    fetchImage: GuideImageFetcher,
    scrollHeight: number,
    options: {
      imageHydrator?: ReaderImageHydrator;
      downloads?: GuideDownloadTasks;
      loadGuideLibrary?: (appId: string) => Promise<GuideLibraryEntry[]>;
      onClose?: () => void;
      onSwitchGuide?: (identity: GuideIdentity) => Promise<void>;
      onRemoveOffline?: (guideId: string) => Promise<CacheClearResult>;
      performance?: ReaderPerformanceTracker;
    } = {},
  ): Promise<HTMLElement> => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <GuideReaderPage
          onRemoveOffline={
            options.onRemoveOffline ??
            (async () => ({ filesRemoved: 1, bytesRemoved: 100 }))
          }
          cache={cache}
          downloads={options.downloads}
          imageHydrator={
            options.imageHydrator ?? new ReaderImageHydrator(fetchImage)
          }
          imageCacheControl={new ReaderImageCacheControl()}
          loadGuideLibrary={options.loadGuideLibrary ?? (async () => [])}
          onClose={options.onClose ?? (() => undefined)}
          onRepairPositions={async () => ""}
          onSwitchGuide={options.onSwitchGuide ?? (async () => undefined)}
          performance={options.performance ?? new ReaderPerformanceTracker()}
        />,
      );
      await Promise.resolve();
    });
    const scroller = container.querySelector<HTMLElement>(
      '[aria-label="指南正文"]',
    );
    if (!scroller) {
      throw new Error("reader scroller did not mount");
    }
    activeScroller = scroller;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 1_000 },
      scrollHeight: { configurable: true, value: scrollHeight },
    });
    scroller.getBoundingClientRect = () =>
      ({
        bottom: 1_000,
        height: 1_000,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
      }) as DOMRect;
    indexTextSections();
    return scroller;
  };

  const unmount = async (): Promise<void> => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    activeScroller = null;
  };

  const buttonNamed = (label: string): HTMLButtonElement => {
    const button = [...(container?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent === label,
    );
    if (!button) {
      throw new Error(`button not found: ${label}`);
    }
    return button;
  };

  const flushMicrotasks = async (): Promise<void> => {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
  };

  const pressKey = (element: Element, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    element.dispatchEvent(event);
    return event;
  };

  it("reuses image URLs when the reader closes and reopens with its shared hydrator", async () => {
    const guide = {
      ...guideFixture(),
      sections: [guideFixture().sections[19]],
    };
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async () => savedPosition,
    });
    await cache.load(identity);
    const fetchImage = vi.fn(async () => ({
      mimeType: "image/png",
      base64: "aW1hZ2U=",
      fromCache: true,
      width: 1,
      height: 1,
    }));
    const revoke = vi.fn();
    const imageHydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => "blob:warm",
      revoke,
    );
    const first = await mount(cache, fetchImage, 3000, { imageHydrator });
    await flushMicrotasks();
    const oldImage = first.querySelector("img")!;
    expect(oldImage.src).toBe("blob:warm");
    await unmount();
    expect(oldImage.isConnected).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    const next = await mount(cache, fetchImage, 3000, { imageHydrator });
    await flushFrame();
    expect(next.querySelector("img")).not.toBe(oldImage);
    expect(next.querySelector("img")?.src).toBe("blob:warm");
    expect(fetchImage).toHaveBeenCalledOnce();
    await act(async () => imageHydrator.clear());
    expect(next.querySelector("img")?.getAttribute("src")).toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("never persists top while a warm restore waits for progressive layout and survives reopen", async () => {
    const guide = guideFixture();
    const saves: number[] = [];
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => savedPosition,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        saves.push(scrollTop);
        return {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
      },
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    let resolveImage!: (value: null) => void;
    const image = new Promise<null>((resolve) => {
      resolveImage = resolve;
    });
    const fetchImage = vi.fn(() => image);

    const earlyScroller = await mount(cache, fetchImage, 1_000);
    await flushFrame();
    await flushFrame();
    expect(document.querySelectorAll("[data-guide-section-id]")).toHaveLength(
      17,
    );
    expect(earlyScroller.scrollTop).toBe(0);
    await act(async () => vi.advanceTimersByTime(150));
    await unmount();

    expect(saves).toEqual([]);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(8_800);

    const restoredScroller = await mount(cache, fetchImage, 12_000);
    for (let frame = 0; frame < 8; frame += 1) {
      await flushFrame();
    }
    expect(document.querySelectorAll("[data-guide-section-id]")).toHaveLength(
      50,
    );
    notifyResize();
    expect(restoredScroller.scrollTop).toBe(8_800);

    resolveImage(null);
    await act(async () => {
      await image;
      await Promise.resolve();
    });
    notifyResize();
    await act(async () => vi.advanceTimersByTime(101));
    await unmount();

    expect(saves).toEqual([8_800]);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(8_800);
  });

  it("keeps the old guide scrollable without rolling back during refresh", async () => {
    const guide = guideFixture();
    const saves: number[] = [];
    let persistedPosition = savedPosition;
    let blockRefresh = false;
    let resolveRefresh!: (guide: DownloadedGuide) => void;
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () =>
        blockRefresh
          ? new Promise<DownloadedGuide>((resolve) => {
              resolveRefresh = resolve;
            })
          : guide,
      getReaderPosition: async () => persistedPosition,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        saves.push(scrollTop);
        persistedPosition = {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
        return persistedPosition;
      },
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    let report!: (progress: GuideImageDownloadProgress) => void;
    let finish!: () => void;
    const downloads = new GuideDownloadTasks(async (_identity, progress) => {
      report = progress;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const scroller = await mount(cache, async () => null, 12_000, {
      downloads,
    });
    for (let frame = 0; frame < 8; frame += 1) {
      await flushFrame();
    }
    await flushMicrotasks();
    notifyResize();
    await act(async () => vi.advanceTimersByTime(101));

    blockRefresh = true;
    await act(async () => buttonNamed("更新").click());
    await flushMicrotasks();

    expect(scroller.style.overflowY).toBe("auto");
    expect(
      buttonNamed("更新中…").querySelector('[data-grip-busy="true"]'),
    ).not.toBeNull();
    expect(buttonNamed("搜索").disabled).toBe(false);
    expect(buttonNamed("章节 1").disabled).toBe(false);
    const oldBody = scroller.querySelector("[data-guide-search-body]");
    scroller.querySelector<HTMLElement>(
      '[data-guide-section-id="20"]',
    )!.getBoundingClientRect = () =>
      ({ top: 4_000 - scroller.scrollTop }) as DOMRect;
    await act(async () =>
      container!
        .querySelector<HTMLButtonElement>('[data-grip-toc-section="20"]')!
        .click(),
    );
    await flushFrame();
    expect(scroller.scrollTop).toBe(4_000);
    await act(async () => buttonNamed("搜索").click());
    const search = container!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "精准命中");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(buttonNamed("下一个").disabled).toBe(false);
    await act(async () => buttonNamed("下一个").click());
    expect(scroller.scrollTop).toBe(3_952);
    expect(scroller.querySelector("[data-guide-search-body]")).toBe(oldBody);
    await act(async () => buttonNamed("关闭搜索").click());
    await act(async () => pressKey(scroller, "Escape"));
    await flushFrame();
    let work!: Promise<void>;
    await act(async () => {
      work = downloads.start(identity, true);
    });
    await act(async () =>
      report({ completed: 2, total: 5, failed: 1, error: "网络中断" }),
    );
    expect(container?.querySelector('[role="status"]')?.textContent).toContain(
      "1 张图片失败，其余继续下载",
    );
    expect(container?.textContent).toContain("旧版仍可阅读");
    expect(buttonNamed("取消更新").disabled).toBe(false);
    expect(buttonNamed("取消更新").getAttribute("aria-label")).toContain("2/5");
    expect(cache.peek(identity)?.guide).toBe(guide);

    await act(async () => {
      scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
      scroller.scrollTop = 4_600;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      resolveRefresh({ ...guide, fetchedAt: 2 });
      finish();
      await work;
      await Promise.resolve();
    });
    await flushMicrotasks();
    await flushFrame();
    await flushFrame();

    expect(scroller.scrollTop).toBe(4_600);
    await act(async () => vi.advanceTimersByTime(400));
    await unmount();
    await flushMicrotasks();

    expect(saves[saves.length - 1]).toBe(4_600);
    expect(persistedPosition.scrollTop).toBe(4_600);
  });

  it("cancels an update from the existing button without changing the old body or reading position", async () => {
    const guide = guideFixture();
    let saved = savedPosition;
    let finish!: () => void;
    let signal!: AbortSignal;
    const downloads = new GuideDownloadTasks(
      async (_identity, progress, abort) => {
        signal = abort;
        progress({ completed: 2, total: 5 });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        abort.throwIfAborted();
      },
    );
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async (_identity, force) => {
        if (force) {
          await downloads.start(identity, true);
          if (downloads.getSnapshot(identity.guideId)?.phase !== "complete")
            throw new Error("canceled");
        }
        return guide;
      },
      getReaderPosition: async () => saved,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        saved = {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
        return saved;
      },
    });
    await cache.load(identity);
    const scroller = await mount(cache, async () => null, 12_000, {
      downloads,
    });
    for (let frame = 0; frame < 8; frame++) await flushFrame();
    await flushMicrotasks();
    notifyResize();
    await act(async () => vi.advanceTimersByTime(101));
    const body = container?.querySelector('[data-guide-section-id="40"]');
    await act(async () => buttonNamed("更新").click());
    await flushMicrotasks();
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
      scroller.scrollTop = 4600;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      buttonNamed("取消更新").click();
    });
    expect(signal.aborted).toBe(true);
    expect(buttonNamed("取消中").disabled).toBe(true);
    expect(container?.textContent).toContain("等待正在保存的图片完成");
    expect(scroller.style.overflowY).toBe("auto");
    await act(async () => finish());
    await flushMicrotasks();
    for (let frame = 0; frame < 3; frame++) await flushFrame();
    expect(buttonNamed("更新").disabled).toBe(false);
    expect(container?.textContent).toContain("更新已取消，继续阅读原指南");
    expect(container?.textContent).not.toContain("更新失败");
    expect(cache.peek(identity)?.guide).toBe(guide);
    expect(container?.querySelector('[data-guide-section-id="40"]')).toBe(body);
    expect(scroller.scrollTop).toBe(4600);
    await act(async () => vi.advanceTimersByTime(400));
    await unmount();
    expect(saved.scrollTop).toBe(4600);
  });

  it("adopts a background update after reopening without replacing the old body early or losing scroll", async () => {
    const guide = guideFixture();
    let saved = savedPosition;
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => saved,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        saved = {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
        return saved;
      },
    });
    await cache.load(identity);
    let finish!: () => void;
    const updated = {
      ...guide,
      fetchedAt: 2,
      sections: guide.sections.map((section) => ({
        ...section,
        html: section.html.replace("正文", "新版正文"),
      })),
    };
    let report!: (progress: GuideImageDownloadProgress) => void;
    const downloads = new GuideDownloadTasks(async (_identity, progress) => {
      report = progress;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      cache.acceptOfflineGuide(updated);
    });
    const work = downloads.start(identity, true);
    await Promise.resolve();
    await mount(cache, async () => null, 12_000, { downloads });
    await unmount();
    const scroller = await mount(cache, async () => null, 12_000, {
      downloads,
    });
    for (let frame = 0; frame < 8; frame++) await flushFrame();
    await flushMicrotasks();
    notifyResize();
    await act(async () => vi.advanceTimersByTime(101));
    expect(cache.peek(identity)?.guide).toBe(guide);
    expect(buttonNamed("取消更新").disabled).toBe(false);
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
      scroller.scrollTop = 4600;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => report({ completed: 3, total: 3, publishing: true }));
    expect(buttonNamed("保存中").disabled).toBe(true);
    await act(async () => buttonNamed("保存中").click());
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("downloading");
    await act(async () => {
      finish();
      await work;
    });
    await flushMicrotasks();
    for (let frame = 0; frame < 4; frame++) await flushFrame();
    expect(cache.peek(identity)?.guide).toBe(updated);
    expect(scroller.scrollTop).toBe(4600);
    await act(async () => vi.advanceTimersByTime(400));
    expect(saved.scrollTop).toBe(4600);
  });

  it("keeps the saved bookmark when a background update completes before the old layout has restored", async () => {
    const guide = guideFixture();
    let saved = savedPosition;
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => saved,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        saved = {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
        return saved;
      },
    });
    await cache.load(identity);
    let finish!: () => void;
    const updated = {
      ...guide,
      fetchedAt: 2,
      sections: guide.sections.map((section) => ({
        ...section,
        html: section.html.replace("正文", "新版正文"),
      })),
    };
    const downloads = new GuideDownloadTasks(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      cache.acceptOfflineGuide(updated);
    });
    const work = downloads.start(identity, true);
    await Promise.resolve();
    const scroller = await mount(cache, async () => null, 1000, { downloads });
    expect(document.querySelectorAll("[data-guide-section-id]")).toHaveLength(
      1,
    );
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      finish();
      await work;
    });
    expect(saved.scrollTop).toBe(8800);
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 12000,
    });
    for (let frame = 0; frame < 8; frame++) await flushFrame();
    notifyResize();
    await act(async () => vi.advanceTimersByTime(101));
    expect(scroller.scrollTop).toBe(8800);
    await unmount();
    expect(saved.scrollTop).toBe(8800);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(8800);
  });

  it.each([false, true])(
    "loads image 513 and later chapters with bounded active work (same viewport: %s)",
    async (sameViewport) => {
      const observed: HTMLImageElement[] = [];
      let intersect!: IntersectionObserverCallback;
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(callback: IntersectionObserverCallback) {
            intersect = callback;
          }
          observe(image: HTMLImageElement) {
            observed.push(image);
          }
          disconnect() {}
        },
      );
      const repeatedUrl = "https://images.steamusercontent.com/shared.png";
      const lastUrl = "https://images.steamusercontent.com/last.png";
      const guide = guideFixture();
      guide.sections = [
        {
          id: "1",
          title: "第一章",
          html: Array.from(
            { length: 513 },
            (_, index) =>
              `<img alt="${index + 1}" data-grip-image-url="${repeatedUrl}">`,
          ).join(""),
        },
        {
          id: "2",
          title: "第二章",
          html: `<img alt="514" data-grip-image-url="${lastUrl}">`,
        },
      ];
      const cache = new ReaderSessionCache({
        getCachedGuide: async () => guide,
        getGuide: async () => guide,
        getReaderPosition: async () => null,
        saveReaderPosition: async (
          _key,
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
        ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
      });
      await cache.load(identity);
      const fetchImage = vi.fn(async () => ({
        mimeType: "image/png",
        base64: "AQID",
        fromCache: true,
        width: 1,
        height: 1,
      }));
      let blob = 0;
      const imageHydrator = new ReaderImageHydrator(
        fetchImage,
        3,
        () => `blob:${++blob}`,
        () => {},
      );
      const hydrate = vi.spyOn(imageHydrator, "hydrateImages");
      const scroller = await mount(cache, fetchImage, 30000, { imageHydrator });
      for (let frame = 0; frame < 3; frame++) await flushFrame();
      expect(observed).toHaveLength(514);
      observed.forEach((image, index) => {
        image.getBoundingClientRect = () =>
          ({
            top: sameViewport ? 100 : index * 50 - scroller.scrollTop,
            bottom: sameViewport ? 140 : index * 50 + 40 - scroller.scrollTop,
          }) as DOMRect;
      });
      await act(async () => {
        intersect(
          observed.map((target) => ({
            target,
            isIntersecting: true,
          })) as unknown as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(observed[0].src).toBe("blob:1");
      expect(observed[512].getAttribute("src")).toBeNull();
      await act(async () => {
        if (sameViewport) observed[0].dispatchEvent(new Event("load"));
        else {
          scroller.dispatchEvent(new Event("wheel"));
          scroller.scrollTop = 25500;
          scroller.dispatchEvent(new Event("scroll"));
        }
      });
      await flushFrame();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(observed[512].src).toBe("blob:1");
      expect(observed[513].src).toBe("blob:2");
      expect(fetchImage.mock.calls).toEqual([
        [repeatedUrl, true],
        [lastUrl, true],
      ]);
      for (const [candidates, residentOnly] of hydrate.mock.calls) {
        if (!residentOnly)
          expect([...candidates].length).toBeLessThanOrEqual(512);
      }
    },
  );

  it("reports visible image capacity failure honestly and allows choosing an image with its button or A", async () => {
    let intersect!: IntersectionObserverCallback;
    const observed: HTMLImageElement[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe(image: HTMLImageElement) {
          observed.push(image);
        }
        disconnect() {}
      },
    );
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "大图",
        html: '<p>正文</p><img alt="一" data-grip-image-url="https://a/1"><img alt="二" data-grip-image-url="https://a/2">',
      },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    const performance = new ReaderPerformanceTracker();
    const trace = performance.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: Date.now(),
    });
    performance.bind(trace, identity);
    performance.markRouteRequested(trace);
    const fetchImage = vi.fn(async () => ({
      mimeType: "image/png",
      base64: "AQID",
      fromCache: true,
      width: 4096,
      height: 4096,
    }));
    let blob = 0;
    const imageHydrator = new ReaderImageHydrator(
      fetchImage,
      3,
      () => `blob:${++blob}`,
      () => {},
    );
    const scroller = await mount(cache, fetchImage, 3000, {
      performance,
      imageHydrator,
    });
    observed.forEach((image) => {
      image.getBoundingClientRect = () =>
        ({ top: 100, bottom: 300 }) as DOMRect;
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
    });
    await act(async () => {
      intersect(
        observed.map((target) => ({
          target,
          isIntersecting: true,
        })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let frame = 0; frame < 3; frame++) await flushFrame();
    notifyResize();
    await act(async () => vi.advanceTimersByTimeAsync(101));
    expect(observed[0].dataset.gripImageState).toBe("ready");
    expect(observed[1].dataset.gripImageState).toBe("capacity");
    expect(performance.getSnapshot().latest?.positionOutcome).toBe(
      "unavailable",
    );
    expect(performance.getSnapshot().warmPositionFailureCount).toBe(1);
    expect(performance.getSnapshot().warmSpinnerCount).toBe(0);
    expect(scroller.getAttribute("data-ok-action")).toBe("优先显示此图");
    await act(async () => {
      buttonNamed("图片内存已满，优先显示此图").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(observed[1].dataset.gripImageState).toBe("ready");
    expect(observed[0].dataset.gripImageState).toBe("capacity");
    await act(async () => {
      pressKey(scroller, "Enter");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(observed[0].dataset.gripImageState).toBe("ready");
    expect(observed[1].dataset.gripImageState).toBe("capacity");
    expect(fetchImage).toHaveBeenCalledTimes(4);
    await unmount();
    imageHydrator.clear();
  });

  it("does not count a deferred visible image as a restored first screen", async () => {
    let intersect!: IntersectionObserverCallback;
    const observed: HTMLImageElement[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe(image: HTMLImageElement) {
          observed.push(image);
        }
        disconnect() {}
      },
    );
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "图文",
        html: '<p>正文</p><img data-grip-image-url="https://a/1"><img data-grip-image-url="https://a/2">',
      },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    let release!: (value: null) => void;
    const fetchImage = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    const imageHydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => "blob:unused",
      () => {},
      64 * 1024 * 1024,
      64,
      1,
    );
    const performance = new ReaderPerformanceTracker();
    const trace = performance.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: Date.now(),
    });
    performance.bind(trace, identity);
    performance.markRouteRequested(trace);
    await mount(cache, fetchImage, 3000, { performance, imageHydrator });
    observed.forEach((image) => {
      image.getBoundingClientRect = () =>
        ({ top: 100, bottom: 300 }) as DOMRect;
    });
    await act(async () =>
      intersect(
        observed.map((target) => ({
          target,
          isIntersecting: true,
        })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    for (let frame = 0; frame < 3; frame++) await flushFrame();
    expect(observed[1].dataset.gripImageState).toBe("deferred");
    await act(async () => vi.advanceTimersByTime(301));
    expect(performance.getSnapshot().latest).toBeNull();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(performance.getSnapshot().latest?.positionOutcome).toBe(
      "unavailable",
    );
    await unmount();
    imageHydrator.clear();
    release(null);
    await flushMicrotasks();
  });

  it("does not add a 100 ms stabilization delay to a new text-only first screen", async () => {
    const guide = guideFixture();
    guide.sections = [guide.sections[0]];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    const performance = new ReaderPerformanceTracker();
    const trace = performance.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: Date.now(),
    });
    performance.bind(trace, identity);
    performance.markRouteRequested(trace);
    await mount(cache, async () => null, 1000, { performance });
    for (let frame = 0; frame < 3; frame++) await flushFrame();
    await act(async () => vi.advanceTimersByTime(0));
    expect(performance.getSnapshot().latest?.positionOutcome).toBe("skipped");
    expect(performance.getSnapshot().latest?.positionSettledMs).toBe(0);
  });

  it("fits both Steam and HTML tables with wrapping cells and bounded images", async () => {
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "图文表格",
        html: [
          '<div class="bb_table"><div class="bb_table_tr"><div class="bb_table_th">标题与描述</div><div class="bb_table_th">获取注解</div></div><div class="bb_table_tr"><div class="bb_table_td"><img width="2048" height="512" alt="图标"></div><div class="bb_table_td">新手教程，随主线必定能获取</div></div></div>',
          '<table width="3000"><thead><tr><th>标题与描述</th><th>获取注解</th></tr></thead><tbody><tr><td><img width="2048" height="512" alt="图标"></td><td>https://example.com/averylongunbrokentablecellvalue</td></tr></tbody></table>',
        ].join(""),
      },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: vi.fn(),
    });
    await cache.load(identity);
    const scroller = await mount(cache, async () => null, 1_000);
    const tables = scroller.querySelectorAll(".bb_table, table");
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      const style = getComputedStyle(table);
      expect(style.tableLayout).toBe("fixed");
      expect(style.width).toBe("100%");
      for (const cell of table.querySelectorAll(
        ".bb_table_td, .bb_table_th, td, th",
      )) {
        expect(getComputedStyle(cell).overflowWrap).toBe("anywhere");
        expect(getComputedStyle(cell).whiteSpace).toBe("normal");
      }
      expect(getComputedStyle(table.querySelector("img")!).maxWidth).toBe(
        "100%",
      );
    }
  });

  it("shows full focused chapter titles in an overlay and highlights the current chapter without reflow", async () => {
    const guide = guideFixture();
    const title = "第一章：完整的章节名称与很长的任务说明";
    guide.sections = [
      { id: "1", title, html: "<p>第一章正文</p>" },
      { id: "2", title: "第二章", html: "<p>第二章正文</p>" },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    const scroller = await mount(cache, async () => null, 3_000);
    await flushFrame();
    const sections = [
      ...scroller.querySelectorAll<HTMLElement>("[data-guide-section-id]"),
    ];
    sections.forEach((section, index) => {
      section.getBoundingClientRect = () =>
        ({ top: index * 600 - scroller.scrollTop }) as DOMRect;
    });
    await act(async () => {
      scroller.scrollTop = 650;
      scroller.dispatchEvent(new Event("scroll"));
    });
    const toc = container!.querySelector<HTMLElement>(
      '[aria-label="指南目录"]',
    )!;
    const first = toc.querySelector<HTMLElement>(
      '[data-grip-toc-section="1"]',
    )!;
    const second = toc.querySelector<HTMLElement>(
      '[data-grip-toc-section="2"]',
    )!;
    toc.getBoundingClientRect = () => ({ left: 712 }) as DOMRect;
    first.getBoundingClientRect = () => ({ top: 100, bottom: 140 }) as DOMRect;
    expect(second.getAttribute("aria-current")).toBe("location");
    expect(first.hasAttribute("aria-current")).toBe(false);
    const body = scroller.querySelector("[data-guide-search-body]");
    await act(async () => first.focus());
    expect(first.textContent).toBe(title);
    expect(first.style.whiteSpace).toBe("normal");
    expect(first.style.overflowWrap).toBe("anywhere");
    expect(toc.style.position).toBe("absolute");
    expect(toc.style.width).toBe("340px");
    expect(scroller.style.marginRight).toBe("172px");
    expect(toc.getAttribute("aria-modal")).toBe("true");
    expect(scroller.scrollTop).toBe(650);
    expect(scroller.querySelector("[data-guide-search-body]")).toBe(body);
    await act(async () => pressKey(first, "Escape"));
    await flushFrame();
    expect(toc.style.width).toBe("172px");
    expect(document.activeElement).toBe(scroller);
    expect(scroller.scrollTop).toBe(650);
  });

  it.each([1000, 6000])(
    "opens a %i-pixel-high image at a readable width, zooms and pans, then returns to the untouched position",
    async (height) => {
      const guide = guideFixture();
      guide.sections = [
        {
          id: "1",
          title: "地图",
          html: '<p>地图位置</p><img alt="攻略地图" data-grip-image-url="https://images.steamusercontent.com/map.png">',
        },
      ];
      const backend: ReaderSessionBackend = {
        getCachedGuide: async () => guide,
        getGuide: async () => guide,
        getReaderPosition: async () => null,
        saveReaderPosition: async (
          _key,
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
        ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
      };
      const cache = new ReaderSessionCache(backend);
      await cache.load(identity);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:map");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        800,
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        600,
      );
      const fetchImage = vi.fn(async () => ({
        mimeType: "image/png",
        base64: "AQID",
        fromCache: true,
        width: 2000,
        height,
      }));
      const close = vi.fn();
      const scroller = await mount(cache, fetchImage, 3000, { onClose: close });
      await act(async () => vi.advanceTimersByTimeAsync(0));
      const original = scroller.querySelector("img")!;
      original.getBoundingClientRect = () =>
        ({ top: 100, bottom: 400 }) as DOMRect;
      await act(async () => {
        scroller.scrollTop = 234;
        scroller.dispatchEvent(new Event("scroll"));
        original.click();
      });
      const viewer = container!.querySelector<HTMLElement>(
        '[aria-label="图片全屏查看"]',
      )!;
      expect(viewer).not.toBeNull();
      expect(scroller.parentElement?.inert).toBe(true);
      const enlarged = viewer.querySelector("img")!;
      expect(enlarged.src).toBe(original.src);
      const width = parseFloat(enlarged.style.width);
      expect(width).toBe(768);
      expect(parseFloat(enlarged.style.height)).toBe((height * 768) / 2000);
      if (height > 2000) {
        await act(async () => buttonNamed("适应屏幕").click());
        expect(parseFloat(enlarged.style.height)).toBeCloseTo(568);
        // Reopening a long image starts at readable width again.
        await act(async () => buttonNamed("返回正文").click());
        await act(async () => original.click());
      }
      const activeImage = container!.querySelector<HTMLImageElement>(
        '[aria-label="图片全屏查看"] img',
      )!;
      await act(async () => buttonNamed("放大").click());
      expect(parseFloat(activeImage.style.width)).toBeGreaterThan(width);
      const view = container!.querySelector<HTMLElement>(
        '[aria-label="图片移动区域"]',
      )!;
      expect(view.scrollLeft).toBeCloseTo(
        (parseFloat(activeImage.style.width) - 800) / 2,
      );
      const left = view.scrollLeft;
      await act(async () => pressKey(view, "ArrowRight"));
      expect(view.scrollLeft).toBeGreaterThan(left);
      await act(async () => pressKey(view, "Escape"));
      await flushFrame();
      expect(
        container!.querySelector('[aria-label="图片全屏查看"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(scroller);
      expect(scroller.scrollTop).toBe(234);
      expect(scroller.querySelector("img")).toBe(original);
      expect(close).not.toHaveBeenCalled();
      expect(fetchImage).toHaveBeenCalledOnce();
      expect(scroller.getAttribute("data-ok-action")).toBe("查看图片");
      await act(async () => pressKey(scroller, "Enter"));
      expect(
        container!.querySelector('[aria-label="图片全屏查看"]'),
      ).not.toBeNull();
    },
  );

  it("uses X and direction navigation without reflow, and unwinds search and directory one layer at a time", async () => {
    const guide = guideFixture();
    guide.sections = guide.sections.slice(0, 2);
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    const close = vi.fn();
    const scroller = await mount(cache, async () => null, 3000, {
      onClose: close,
    });
    await flushFrame();
    await flushFrame();
    const body = scroller.querySelector("[data-guide-search-body]");
    scroller.scrollTop = 234;
    const margin = scroller.style.marginRight;
    await act(async () => pressKey(scroller, "Secondary"));
    await flushFrame();
    const toc = container!.querySelector<HTMLElement>(
      '[aria-label="指南目录"]',
    )!;
    expect(toc.getAttribute("data-expanded")).toBe("true");
    expect(toc.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.hasAttribute("data-grip-toc-section")).toBe(
      true,
    );
    expect(scroller.hasAttribute("inert")).toBe(true);
    expect(scroller.style.marginRight).toBe(margin);
    expect(scroller.querySelector("[data-guide-search-body]")).toBe(body);
    expect(scroller.scrollTop).toBe(234);
    const controls = [...toc.querySelectorAll<HTMLButtonElement>("button")];
    const first = controls[0];
    const last = controls[controls.length - 1];
    await act(async () => {
      last.focus();
      pressKey(last, "Tab");
    });
    expect(document.activeElement).toBe(first);
    await act(async () =>
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(last);
    await act(async () => pressKey(document.activeElement!, "ArrowLeft"));
    await flushFrame();
    expect(document.activeElement).toBe(scroller);
    expect(toc.getAttribute("data-expanded")).toBe("false");
    expect(scroller.hasAttribute("inert")).toBe(false);
    await act(async () => pressKey(scroller, "Secondary"));
    // Closing before the scheduled focus must not reopen the directory.
    await act(async () => pressKey(scroller, "Escape"));
    await flushFrame();
    expect(toc.getAttribute("data-expanded")).toBe("false");
    expect(document.activeElement).toBe(scroller);
    await act(async () => pressKey(scroller, "ArrowRight"));
    await flushFrame();
    expect(toc.getAttribute("data-expanded")).toBe("true");
    await act(async () => pressKey(document.activeElement!, "Secondary"));
    await flushFrame();
    expect(document.activeElement).toBe(scroller);
    await act(async () =>
      scroller.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(container!.querySelector('[aria-label="指南搜索"]')).not.toBeNull();
    expect(scroller.style.marginRight).toBe(margin);
    expect(scroller.hasAttribute("inert")).toBe(false);
    const search = container!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      search.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "章节");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(toc.getAttribute("role")).toBe("search");
    const result = toc.querySelector<HTMLElement>(
      '[aria-label^="跳转到搜索结果"]',
    )!;
    await act(async () => result.focus());
    expect(document.activeElement).toBe(result);
    expect(toc.getAttribute("role")).toBe("search");
    expect(scroller.hasAttribute("inert")).toBe(false);
    await act(async () =>
      result.dispatchEvent(gamepadEvent("onCancel", GamepadButton.CANCEL)),
    );
    await flushFrame();
    expect(container!.querySelector('[aria-label="指南搜索"]')).toBeNull();
    expect(toc.getAttribute("data-expanded")).toBe("true");
    expect(toc.getAttribute("role")).toBe("dialog");
    expect(scroller.hasAttribute("inert")).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(toc.getAttribute("data-expanded")).toBe("true");
    expect(close).not.toHaveBeenCalled();
    await act(async () =>
      document.activeElement!.dispatchEvent(
        gamepadEvent("onCancel", GamepadButton.CANCEL),
      ),
    );
    await flushFrame();
    expect(document.activeElement).toBe(scroller);
    expect(toc.getAttribute("role")).toBe("navigation");
    expect(scroller.hasAttribute("inert")).toBe(false);
    expect(close).not.toHaveBeenCalled();
    await act(async () => pressKey(scroller, "Escape"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("lets A open every ready image in the viewport with trigger switching and preserves the original article", async () => {
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "双图表格",
        html: '<p>图片对照</p><img alt="第一张" data-grip-image-url="https://images.steamusercontent.com/first.png"><img alt="第二张" data-grip-image-url="https://images.steamusercontent.com/second.png">',
      },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async () => savedPosition,
    });
    await cache.load(identity);
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:gallery-${++sequence}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchImage = vi.fn(async () => ({
      mimeType: "image/png",
      base64: "AQID",
      fromCache: true,
      width: 120,
      height: 100,
    }));
    const scroller = await mount(cache, fetchImage, 3000);
    await flushFrame();
    await flushMicrotasks();
    const original = [...scroller.querySelectorAll("img")];
    for (const img of original) {
      img.getBoundingClientRect = () =>
        ({ top: 250, bottom: 350, width: 120, height: 100 }) as DOMRect;
    }
    notifyResize();
    await flushFrame();
    await act(async () => {
      scroller.scrollTop = 234;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flushFrame();
    await act(async () => pressKey(scroller, "Enter"));
    const dialog = container!.querySelector('[aria-label="图片全屏查看"]')!;
    expect(dialog.querySelector("img")?.alt).toBe("第一张");
    await act(async () => pressKey(document.activeElement!, "TriggerRight"));
    expect(dialog.querySelector("img")?.alt).toBe("第二张");
    await act(async () => pressKey(document.activeElement!, "Escape"));
    await flushFrame();
    expect(document.activeElement).toBe(scroller);
    expect(scroller.scrollTop).toBe(234);
    expect([...scroller.querySelectorAll("img")]).toEqual(original);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("reads extracted Heybox screenshots from cache with fit-width, zoom and gallery navigation without downloading", async () => {
    const heyboxIdentity = {
      appId: "1113000",
      guideId: "heybox-249c72219fed",
    };
    vi.spyOn(DeckyUI, "useParams").mockReturnValue(heyboxIdentity);
    // Synthetic public DOM and cached image bytes, not a device/browser acceptance test.
    const article = new DOMParser().parseFromString(
      `<div class="post__container">
        <h1 class="section-title__content">p4g毕业面具展示</h1>
        <span class="link-user__username">R</span>
        <div class="hb-article">
          <div><img src="https://imgheybox.max-c.com/web/bbs/screenshot-1.webp" alt="第一张"></div>
          <h4 class="img-desc">面具一</h4>
          <div><img src="https://imgheybox.max-c.com/web/bbs/screenshot-2.webp" alt="第二张"></div>
          <h4 class="img-desc">面具二</h4>
        </div>
      </div>`,
      "text/html",
    );
    const rendered = extractHeyboxArticle(
      article,
      "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed",
    );
    expect(rendered.guideId).toBe(heyboxIdentity.guideId);
    expect(rendered.sections).toHaveLength(1);
    expect(rendered.imageUrls).toHaveLength(2);
    const captions = [...article.querySelectorAll(".img-desc")].map(
      (caption) => caption.textContent,
    );
    const guide: DownloadedGuide = {
      ...rendered,
      fetchedAt: 1,
      fromCache: true,
      stale: false,
    };
    const getGuide = vi.fn(async () => guide);
    const getCachedGuide = vi.fn(async () => guide);
    const cache = new ReaderSessionCache({
      getCachedGuide,
      getGuide,
      getReaderPosition: async () => null,
      saveReaderPosition: async () => savedPosition,
    });
    const download = vi.fn();
    const downloads = new GuideDownloadTasks(download);
    const fetchImage = vi.fn(async (url: string) => {
      expect(rendered.imageUrls).toContain(url);
      return {
        mimeType: "image/webp",
        base64: "AQID",
        fromCache: true,
        width: 1280,
        height: 582,
      };
    });
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:heybox-${++sequence}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    await cache.preload(heyboxIdentity);
    const scroller = await mount(cache, fetchImage, 3000, {
      downloads,
      imageHydrator: new ReaderImageHydrator(fetchImage),
    });
    await flushFrame();
    await flushMicrotasks();
    const original = [...scroller.querySelectorAll("img")];
    expect(original).toHaveLength(rendered.imageUrls.length);
    for (const caption of captions)
      expect(scroller.textContent).toContain(caption);
    for (const image of original) {
      expect(image.src).toMatch(/^blob:heybox-/);
      expect(image.width).toBe(1280);
      expect(image.height).toBe(582);
      expect(getComputedStyle(image).maxWidth).toBe("100%");
      expect(getComputedStyle(image).height).toBe("auto");
      image.getBoundingClientRect = () =>
        ({ top: 250, bottom: 600, width: 768, height: 349.2 }) as DOMRect;
    }
    notifyResize();
    await flushFrame();
    await act(async () => {
      scroller.scrollTop = 234;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flushFrame();
    await act(async () => pressKey(scroller, "Enter"));
    const dialog = container!.querySelector('[aria-label="图片全屏查看"]')!;
    expect(dialog).not.toBeNull();
    const enlarged = dialog.querySelector("img")!;
    expect(enlarged.src).toBe(original[0].src);
    expect(parseFloat(enlarged.style.width)).toBe(768);
    expect(parseFloat(enlarged.style.height)).toBeCloseTo((582 * 768) / 1280);
    await act(async () => pressKey(document.activeElement!, "BumperRight"));
    expect(parseFloat(enlarged.style.width)).toBeGreaterThan(768);
    await act(async () => pressKey(document.activeElement!, "TriggerRight"));
    expect(dialog.querySelector("img")?.src).toBe(original[1].src);
    expect(container!.querySelectorAll('img[src^="http"]')).toHaveLength(0);
    await act(async () => pressKey(document.activeElement!, "Escape"));
    await flushFrame();
    expect(container!.querySelector('[aria-label="图片全屏查看"]')).toBeNull();
    expect(document.activeElement).toBe(scroller);
    expect(scroller.scrollTop).toBe(234);
    expect([...scroller.querySelectorAll("img")]).toEqual(original);
    expect(getCachedGuide).toHaveBeenCalledExactlyOnceWith(
      heyboxIdentity.guideId,
    );
    expect(getGuide).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(fetchImage).toHaveBeenCalledTimes(rendered.imageUrls.length);
  });

  it("coalesces viewport work, selects images in DOM order and saves before a pending frame", async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "图片",
        html: '<p>正文</p><img alt="第一张" data-grip-image-url="https://a/1"><img alt="第二张" data-grip-image-url="https://a/1">',
      },
    ];
    const save = vi.fn(
      async (_key, scrollTop, sectionId, anchorText, anchorOffset) => ({
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 2,
      }),
    );
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: save,
    });
    await cache.load(identity);
    const imageHydrator = new ReaderImageHydrator(
      async () => ({
        mimeType: "image/png",
        base64: "AQID",
        fromCache: true,
        width: 96,
        height: 96,
      }),
      1,
      () => "blob:shared",
      () => {},
    );
    const scroller = await mount(cache, async () => null, 3000, {
      imageHydrator,
    });
    const images = [...scroller.querySelectorAll("img")];
    const measure = images.map((image) =>
      vi
        .spyOn(image, "getBoundingClientRect")
        .mockReturnValue({ top: 100, bottom: 196 } as DOMRect),
    );
    await act(async () => {
      // IntersectionObserver reports arrival order, not necessarily document order.
      intersect(
        [...images].reverse().map((target) => ({
          target,
          isIntersecting: true,
        })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });
    await flushFrame();
    await act(async () => scroller.dispatchEvent(new Event("wheel")));
    await flushFrame();
    for (const spy of measure) spy.mockClear();
    const query = vi.spyOn(
      scroller.querySelector(".grip-reader-content")!,
      "querySelectorAll",
    );
    await act(async () => {
      for (let count = 0; count < 100; count++)
        scroller.dispatchEvent(new Event("scroll"));
    });
    expect(measure.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    await flushFrame();
    expect(measure.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
    expect(query).not.toHaveBeenCalled();
    await act(async () => pressKey(scroller, "Enter"));
    expect(
      container!
        .querySelector('[aria-label="图片全屏查看"] img')
        ?.getAttribute("alt"),
    ).toBe("第一张");
    await act(async () => pressKey(document.activeElement!, "Escape"));
    await flushFrame();
    await act(async () => {
      scroller.scrollTop = 456;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(animationFrames.size).toBeGreaterThan(0);
    await unmount();
    expect(animationFrames.size).toBe(0);
    expect(save.mock.calls[save.mock.calls.length - 1]?.[1]).toBe(456);
  });

  it("requires a named confirmation for single-guide deletion and preserves the active article", async () => {
    const guide = guideFixture();
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    let finish!: () => void;
    const remove = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { filesRemoved: 3, bytesRemoved: 1048576 };
    });
    const scroller = await mount(cache, async () => null, 5000, {
      onRemoveOffline: remove,
    });
    await act(async () => pressKey(scroller, "Options"));
    await flushFrame();
    const manage = () => {
      const choice = container!.querySelector<HTMLElement>(
        `[data-grip-guide-choice="${identity.appId}:${identity.guideId}"]`,
      )!;
      choice.focus();
      pressKey(choice, "Secondary");
    };
    await act(async () => manage());
    const confirm = container!.querySelector('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain(guide.title);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => buttonNamed("取消").click());
    expect(remove).not.toHaveBeenCalled();
    await act(async () => manage());
    await act(async () => {
      buttonNamed("确认卸载").click();
    });
    expect(buttonNamed("正在卸载…").getAttribute("aria-disabled")).toBe("true");
    expect(remove).toHaveBeenCalledExactlyOnceWith(identity.guideId);
    await act(async () => {
      finish();
    });
    expect(container!.textContent).toContain("已卸载");
    await act(async () => manage());
    expect(buttonNamed("确认卸载").getAttribute("aria-disabled")).toBe("true");
    expect(container!.querySelector('[aria-label="指南正文"]')).toBe(scroller);
    await act(async () => buttonNamed("取消").click());
    await act(async () => pressKey(scroller, "Escape"));
    await act(async () => buttonNamed("更新").click());
    await act(async () => pressKey(scroller, "Options"));
    await act(async () => manage());
    expect(buttonNamed("确认卸载").getAttribute("aria-disabled")).toBe("false");
  });

  it.each([false, true])(
    "refreshes another guide's uninstall without interrupting reading or downloads (partial cleanup failure: %s)",
    async (partialFailure) => {
      const guide = guideFixture();
      const other: GuideLibraryEntry = {
        ...identity,
        guideId: "3414883888",
        updatedAt: 1,
        cache: {
          title: "另一篇指南",
          author: "作者 B",
          fetchedAt: 1,
          sectionTitle: null,
          stale: false,
        },
      };
      const cache = new ReaderSessionCache({
        getCachedGuide: async () => guide,
        getGuide: async () => guide,
        getReaderPosition: async () => null,
        saveReaderPosition: async (
          _key,
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
        ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
      });
      await cache.load(identity);
      let finishDownload!: () => void;
      const downloads = new GuideDownloadTasks(
        async () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve;
          }),
      );
      let library = [other];
      const loadLibrary = vi.fn(async () => library);
      let failNextRemoval = partialFailure;
      const remove = vi.fn(async () => {
        library = [{ ...other, cache: null }];
        if (failNextRemoval) {
          failNextRemoval = false;
          throw new Error("图片清理失败");
        }
        return { filesRemoved: 1, bytesRemoved: 100 };
      });
      const onSwitchGuide = vi.fn();
      const scroller = await mount(cache, async () => null, 5000, {
        downloads,
        loadGuideLibrary: loadLibrary,
        onRemoveOffline: remove,
        onSwitchGuide,
      });
      await act(async () => {
        scroller.scrollTop = 600;
        scroller.dispatchEvent(new Event("scroll"));
        pressKey(scroller, "Options");
      });
      await flushFrame();
      const choice = (guideId: string) =>
        container!.querySelector<HTMLElement>(
          `[data-grip-guide-choice="${identity.appId}:${guideId}"]`,
        )!;
      await act(async () => pressKey(choice(other.guideId), "Secondary"));
      expect(
        container!.querySelector('[role="alertdialog"]')?.textContent,
      ).toContain(other.cache!.title);
      let work!: Promise<void>;
      await act(async () => {
        work = downloads.start({ ...identity, guideId: "3414883899" });
      });
      expect(buttonNamed("确认卸载").getAttribute("aria-disabled")).toBe(
        "true",
      );
      await act(async () => buttonNamed("确认卸载").click());
      expect(remove).not.toHaveBeenCalled();
      await act(async () => {
        finishDownload();
        await work;
      });
      expect(buttonNamed("确认卸载").getAttribute("aria-disabled")).toBe(
        "false",
      );
      await act(async () => buttonNamed("确认卸载").click());
      expect(remove).toHaveBeenCalledExactlyOnceWith(other.guideId);
      expect(onSwitchGuide).not.toHaveBeenCalled();
      expect(loadLibrary).toHaveBeenCalledTimes(2);
      if (partialFailure) {
        expect(
          container!.querySelector('[role="alertdialog"]')?.textContent,
        ).toContain("图片清理失败");
        expect(buttonNamed("确认清理残留").getAttribute("aria-disabled")).toBe(
          "false",
        );
        await act(async () => buttonNamed("确认清理残留").click());
        expect(remove.mock.calls).toEqual([[other.guideId], [other.guideId]]);
        expect(loadLibrary).toHaveBeenCalledTimes(3);
      }
      expect(choice(other.guideId).textContent).toContain("已卸载");
      expect(choice(identity.guideId).textContent).not.toContain("已卸载");
      expect(container!.querySelector('[aria-label="指南正文"]')).toBe(
        scroller,
      );
      expect(scroller.scrollTop).toBe(600);
      await act(async () => pressKey(choice(identity.guideId), "Secondary"));
      expect(buttonNamed("确认卸载").getAttribute("aria-disabled")).toBe(
        "false",
      );
    },
  );

  it("retries a failed image with A or its own button without rebuilding the article or other images", async () => {
    const failedUrl = "https://images.steamusercontent.com/failed.png";
    const healthyUrl = "https://images.steamusercontent.com/healthy.png";
    const guide = guideFixture();
    guide.sections = [
      {
        id: "1",
        title: "图文章节",
        html: `<p>正文</p><img alt="失败图片" data-grip-image-url="${failedUrl}"><img data-grip-image-url="${healthyUrl}">`,
      },
    ];
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    const payload = {
      mimeType: "image/png",
      base64: "AQID",
      fromCache: true,
      width: 1,
      height: 1,
    };
    let failedAttempts = 0;
    let release!: (image: typeof payload) => void;
    const fetchImage = vi.fn(async (url: string) => {
      if (url === healthyUrl) return payload;
      if (failedAttempts++ === 0) return null;
      return new Promise<typeof payload>((resolve) => {
        release = resolve;
      });
    });
    let nextBlob = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:test-${++nextBlob}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const scroller = await mount(cache, fetchImage, 3_000);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const failed =
      scroller.querySelector<HTMLImageElement>('img[alt="失败图片"]')!;
    const healthy = scroller.querySelector<HTMLImageElement>(
      `img[data-grip-image-url="${healthyUrl}"]`,
    )!;
    const body = scroller.querySelector("[data-guide-search-body]");
    const healthyBlob = healthy.src;
    failed.getBoundingClientRect = () => ({ top: 100, bottom: 148 }) as DOMRect;
    await act(async () => {
      scroller.scrollTop = 234;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flushFrame();
    expect(scroller.getAttribute("data-ok-action")).toBe("重试图片");
    expect(buttonNamed("图片读取失败，重试此图")).not.toBeNull();
    await act(async () => {
      pressKey(scroller, "Enter");
      pressKey(scroller, "Enter");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(buttonNamed("正在重试图片…").disabled).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(3);
    await act(async () => {
      release(payload);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(scroller.querySelector("[data-grip-image-retry]")).toBeNull();
    expect(healthy.src).toBe(healthyBlob);
    expect(failed.src).toBe("blob:test-2");
    expect(scroller.querySelector("[data-guide-search-body]")).toBe(body);
    expect(scroller.scrollTop).toBe(234);

    await act(async () => {
      failed.dispatchEvent(new Event("error"));
      await vi.advanceTimersByTimeAsync(0);
    });
    const retry = buttonNamed("图片读取失败，重试此图");
    await act(async () => {
      retry.focus();
      retry.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      release(payload);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(scroller);
    expect(failed.src).toBe("blob:test-3");
    expect(
      fetchImage.mock.calls.filter(([url]) => url === healthyUrl),
    ).toHaveLength(1);
    expect(scroller.scrollTop).toBe(234);
  });

  it("focuses the first alternative when a guide list finishes loading", async () => {
    const guide = guideFixture();
    const cache = new ReaderSessionCache({
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: vi.fn(),
    });
    await cache.load(identity);
    let resolveList!: (entries: GuideLibraryEntry[]) => void;
    const scroller = await mount(cache, async () => null, 12_000, {
      loadGuideLibrary: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });
    await act(async () => pressKey(scroller, "Options"));
    await flushFrame();
    const dialog = container!.querySelector<HTMLElement>(
      '[aria-label="切换指南"]',
    )!;
    expect(document.activeElement).toBe(dialog);
    await act(async () =>
      resolveList([
        { appId: identity.appId, guideId: "123", updatedAt: 1, cache: null },
      ]),
    );
    await flushFrame();
    expect(document.activeElement).toBe(
      dialog.querySelector(
        '[data-grip-guide-choice]:not([data-current="true"])',
      ),
    );
    await act(async () => pressKey(dialog, "Escape"));
    await flushFrame();
    expect(document.activeElement).toBe(scroller);
  });

  it("keeps the reader headerless and lets the current guide return to reading", async () => {
    const guide = guideFixture();
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 2,
      }),
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const scroller = await mount(cache, async () => null, 12_000);

    expect(container?.querySelector(".grip-reader-guide-title")).toBeNull();
    expect(
      [...(container?.querySelectorAll("button") ?? [])].some((button) =>
        ["返回", "上一篇", "下一篇", "切换指南"].includes(
          button.textContent ?? "",
        ),
      ),
    ).toBe(false);

    await act(async () => {
      pressKey(scroller, "Options");
    });
    await flushFrame();
    await flushMicrotasks();
    const page = container?.firstElementChild as HTMLElement | null;
    const dialog = container?.querySelector<HTMLElement>(
      '[aria-label="切换指南"]',
    );
    expect(document.activeElement).toBe(
      dialog?.querySelector('[data-current="true"]'),
    );
    expect(
      [...dialog!.querySelectorAll("button")].some(
        (button) => button.textContent === "关闭",
      ),
    ).toBe(false);
    expect(page?.style.paddingTop).toBe("40px");
    expect(dialog?.style.top).toBe("40px");
    expect(dialog?.classList.contains("grip-reader-guide-switcher")).toBe(true);
    const currentGuide = dialog?.querySelector('[aria-current="page"]');
    expect(currentGuide?.tagName).toBe("BUTTON");
    expect(currentGuide?.textContent).toContain("正在阅读 · 组件回归指南");
    expect(container?.querySelector(".grip-reader-guide-enter")).toBeNull();
    expect(page?.classList.contains("steam-dialog-content")).toBe(true);
    expect(dialog?.classList.contains("steam-dialog-content")).toBe(true);
    await act(async () => (currentGuide as HTMLButtonElement).click());
    await flushFrame();
    expect(container?.querySelector('[aria-label="切换指南"]')).toBeNull();
    expect(document.activeElement).toBe(scroller);
  });

  it("shows every guide without a filter across switcher reopen", async () => {
    const guide = guideFixture();
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 2,
      }),
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const currentGuide: GuideLibraryEntry = {
      appId: identity.appId,
      guideId: identity.guideId,
      updatedAt: 2,
      cache: null,
    };
    const otherGuide: GuideLibraryEntry = {
      appId: identity.appId,
      guideId: "123",
      updatedAt: 1,
      cache: {
        title: "另一篇指南",
        author: "另一位作者",
        fetchedAt: 1,
        sectionTitle: null,
        stale: false,
      },
    };
    const library = [currentGuide, otherGuide];
    const loadGuideLibrary = vi.fn(async () => library);
    const scroller = await mount(cache, async () => null, 12_000, {
      loadGuideLibrary,
    });

    await act(async () => {
      pressKey(scroller, "Options");
    });
    await flushMicrotasks();
    expect(
      container?.querySelector('[aria-label="切换指南"] input'),
    ).toBeNull();
    expect(
      container?.querySelector('[aria-current="page"]')?.textContent,
    ).toContain(guide.title);
    expect(container?.textContent).toContain("另一篇指南");
    await flushFrame();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "打开指南：另一篇指南",
    );

    await act(async () =>
      pressKey(container!.querySelector('[aria-label="切换指南"]')!, "Escape"),
    );
    await act(async () => {
      pressKey(scroller, "Options");
    });
    await flushMicrotasks();

    expect(
      container?.querySelector('[aria-label="切换指南"] input'),
    ).toBeNull();
    expect(
      container?.querySelector('[aria-current="page"]')?.textContent,
    ).toContain(guide.title);
    expect(container?.textContent).toContain("另一篇指南");
    expect(loadGuideLibrary).toHaveBeenCalledTimes(1);
  });

  it("opens the guide switcher with Options and restores reader focus", async () => {
    const guide = guideFixture();
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 2,
      }),
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const onClose = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-guide-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchImage = vi.fn(async () => ({
      mimeType: "image/png",
      base64: "AQID",
      fromCache: true,
      width: 1,
      height: 1,
    }));
    const scroller = await mount(cache, fetchImage, 12_000, { onClose });
    for (let frame = 0; frame < 3; frame += 1) {
      await flushFrame();
    }
    const image = container?.querySelector("img[data-grip-image-url]");
    expect(image?.getAttribute("src")).toBe("blob:cached-guide-image");
    for (let frame = 0; frame < 5; frame += 1) {
      await flushFrame();
    }
    expect(container?.querySelector("img[data-grip-image-url]")).toBe(image);
    const page = container?.firstElementChild;
    expect(page?.getAttribute("data-options-action")).toBe("切换指南");
    scroller.focus();

    let optionsEvent!: KeyboardEvent;
    await act(async () => {
      optionsEvent = pressKey(scroller, "Options");
    });
    await flushFrame();
    await flushMicrotasks();

    expect(optionsEvent.defaultPrevented).toBe(true);
    const dialog = container?.querySelector('[aria-label="切换指南"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(
      dialog?.querySelector('[data-current="true"]'),
    );
    expect(page?.hasAttribute("data-options-action")).toBe(false);

    await act(async () => {
      pressKey(dialog!, "Escape");
    });
    await flushFrame();

    expect(container?.querySelector('[aria-label="切换指南"]')).toBeNull();
    expect(document.activeElement).toBe(scroller);
    expect(page?.getAttribute("data-options-action")).toBe("切换指南");
    expect(onClose).not.toHaveBeenCalled();
    expect(container?.querySelector("img[data-grip-image-url]")).toBe(image);
    expect(image?.getAttribute("src")).toBe("blob:cached-guide-image");
    expect(fetchImage).toHaveBeenCalledTimes(1);

    await act(async () => buttonNamed("搜索").focus());
    await act(async () => {
      pressKey(buttonNamed("搜索"), "Options");
    });
    await flushFrame();
    await act(async () =>
      pressKey(container!.querySelector('[aria-label="切换指南"]')!, "Escape"),
    );
    await flushFrame();
    expect(document.activeElement).toBe(scroller);

    await act(async () => {
      pressKey(scroller, "Escape");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switches through the picker after saving without crossing AppID", async () => {
    const guide = guideFixture();
    const actions: string[] = [];
    const backend: ReaderSessionBackend = {
      getCachedGuide: async (guideId) => ({
        ...guide,
        guideId,
        title: `指南 ${guideId}`,
      }),
      getGuide: async ({ guideId }) => ({
        ...guide,
        guideId,
        title: `指南 ${guideId}`,
      }),
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        actions.push(`save ${guideKey}`);
        return {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
      },
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const entry = (appId: string, guideId: string): GuideLibraryEntry => ({
      appId,
      guideId,
      updatedAt: Number(guideId),
      cache: null,
    });
    const scroller = await mount(cache, async () => null, 12_000, {
      loadGuideLibrary: async () => [
        entry(identity.appId, "10000000000"),
        entry("222", "30"),
        entry(identity.appId, identity.guideId),
        entry(identity.appId, "20"),
      ],
      onSwitchGuide: async (target) => {
        actions.push(`switch ${target.guideId}`);
      },
    });
    await act(async () => {
      pressKey(scroller, "Options");
    });
    await flushMicrotasks();

    expect(container?.textContent).not.toContain("Steam 指南 30");

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>(
          `[data-grip-guide-choice="${identity.appId}:20"]`,
        )
        ?.click();
    });
    await flushMicrotasks();
    expect(actions).toEqual([
      `save ${identity.appId}:${identity.guideId}`,
      "switch 20",
    ]);

    await act(async () => {
      pressKey(scroller, "Options");
    });
    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>(
          `[data-grip-guide-choice="${identity.appId}:10000000000"]`,
        )
        ?.click();
    });
    await flushMicrotasks();
    expect(actions[actions.length - 1]).toBe("switch 10000000000");
  });

  it("keeps a picker load failure visible without switching", async () => {
    const guide = guideFixture();
    const backend: ReaderSessionBackend = {
      getCachedGuide: async (guideId) =>
        guideId === identity.guideId ? guide : null,
      getGuide: async ({ guideId }) => {
        if (guideId === identity.guideId) {
          return guide;
        }
        throw new Error("offline");
      },
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 2,
      }),
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const onSwitchGuide = vi.fn(async () => undefined);
    const scroller = await mount(cache, async () => null, 12_000, {
      loadGuideLibrary: async () => [
        {
          appId: identity.appId,
          guideId: identity.guideId,
          updatedAt: 2,
          cache: null,
        },
        {
          appId: identity.appId,
          guideId: "20",
          updatedAt: 1,
          cache: null,
        },
      ],
      onSwitchGuide,
    });
    await act(async () => {
      pressKey(scroller, "Options");
    });
    await flushMicrotasks();

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>(
          `[data-grip-guide-choice="${identity.appId}:20"]`,
        )
        ?.click();
    });
    await flushMicrotasks();

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "指南打开失败：offline",
    );
    expect(onSwitchGuide).not.toHaveBeenCalled();
  });

  it("retries a library refresh failure without reopening a previously failed guide", async () => {
    const guide = guideFixture();
    const getGuide = vi.fn(async ({ guideId }: GuideIdentity) => {
      if (guideId === identity.guideId) return guide;
      throw new Error("B 正文读取失败");
    });
    const cache = new ReaderSessionCache({
      getCachedGuide: async (guideId) =>
        guideId === identity.guideId ? guide : null,
      getGuide,
      getReaderPosition: async () => null,
      saveReaderPosition: async (
        _key,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => ({ scrollTop, sectionId, anchorText, anchorOffset, updatedAt: 2 }),
    });
    await cache.load(identity);
    let library: GuideLibraryEntry[] = [
      { ...identity, guideId: "20", updatedAt: 1, cache: null },
      {
        ...identity,
        guideId: "30",
        updatedAt: 1,
        cache: {
          title: "指南 C",
          author: "作者 C",
          fetchedAt: 1,
          sectionTitle: null,
          stale: false,
        },
      },
    ];
    const loadLibrary = vi.fn(async () => library);
    const remove = vi.fn(async (guideId: string) => {
      library = library.map((entry) =>
        entry.guideId === guideId ? { ...entry, cache: null } : entry,
      );
      return { filesRemoved: 1, bytesRemoved: 100 };
    });
    const onSwitchGuide = vi.fn(async () => undefined);
    const scroller = await mount(cache, async () => null, 12_000, {
      loadGuideLibrary: loadLibrary,
      onRemoveOffline: remove,
      onSwitchGuide,
    });
    const choice = (guideId: string) =>
      container!.querySelector<HTMLButtonElement>(
        `[data-grip-guide-choice="${identity.appId}:${guideId}"]`,
      )!;
    await act(async () => pressKey(scroller, "Options"));
    await act(async () => choice("20").click());
    await flushMicrotasks();
    expect(choice("20").textContent).toContain("指南打开失败：B 正文读取失败");

    loadLibrary.mockRejectedValueOnce(new Error("指南列表读取失败（测试）"));
    await act(async () => {
      choice("30").focus();
      pressKey(choice("30"), "Secondary");
    });
    await act(async () => buttonNamed("确认卸载").click());
    await flushMicrotasks();

    expect(remove).toHaveBeenCalledExactlyOnceWith("30");
    expect(loadLibrary).toHaveBeenCalledTimes(2);
    expect(
      buttonNamed("重新读取指南列表").closest('[role="alert"]')?.textContent,
    ).toContain("指南列表读取失败（测试）");
    expect(choice("20").textContent).toContain("指南打开失败：B 正文读取失败");
    expect(choice("20").textContent).not.toContain("指南列表读取失败");
    expect(choice("30").textContent).toContain("已卸载");

    await act(async () => buttonNamed("重新读取指南列表").click());
    await flushMicrotasks();
    expect(loadLibrary).toHaveBeenCalledTimes(3);
    expect(container!.textContent).not.toContain("指南列表读取失败（测试）");
    expect(choice("20").textContent).toContain("指南打开失败：B 正文读取失败");
    expect(getGuide.mock.calls.map(([target]) => target.guideId)).toEqual([
      identity.guideId,
      "20",
    ]);
    expect(onSwitchGuide).not.toHaveBeenCalled();
    expect(container!.querySelector('[aria-label="指南正文"]')).toBe(scroller);
  });

  it("interrupts a warm restore to keep exact search matches aligned", async () => {
    const guide = guideFixture();
    const savedScrollTops: number[] = [];
    let blockRefresh = false;
    let resolveRefresh!: (guide: DownloadedGuide) => void;
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () =>
        blockRefresh
          ? new Promise<DownloadedGuide>((resolve) => {
              resolveRefresh = resolve;
            })
          : guide,
      getReaderPosition: async () => savedPosition,
      saveReaderPosition: async (
        _guideKey,
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
      ) => {
        savedScrollTops.push(scrollTop);
        return {
          scrollTop,
          sectionId,
          anchorText,
          anchorOffset,
          updatedAt: 2,
        };
      },
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const scroller = await mount(cache, async () => null, 12_000);
    expect(container?.querySelector('[data-guide-section-id="20"]')).toBeNull();

    await act(async () => buttonNamed("搜索").click());
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="搜索指南正文"]',
    );
    const page = container?.firstElementChild;
    expect(page?.hasAttribute("data-options-action")).toBe(false);
    await act(async () => {
      pressKey(search!, "Options");
    });
    expect(container?.querySelector('[aria-label="切换指南"]')).toBeNull();
    expect(container?.querySelector('[aria-label="指南搜索"]')).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(search, "精准命中");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const results = [
      ...(container?.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="跳转到搜索结果"]',
      ) ?? []),
    ];
    expect(results).toHaveLength(2);
    expect(results[0]?.textContent).toContain(
      "图片章节前文 精准命中 中段 精准命中 后文",
    );

    const selectedRange: { current: Range | null } = { current: null };
    const selection = {
      addRange: vi.fn((range: Range) => {
        selectedRange.current = range;
      }),
      get rangeCount() {
        return selectedRange.current ? 1 : 0;
      },
      getRangeAt: vi.fn(() => selectedRange.current!),
      removeAllRanges: vi.fn(() => {
        selectedRange.current = null;
      }),
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(selection);

    await act(async () => {
      search!.focus();
      search!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(results[0]?.getAttribute("aria-current")).toBeNull();
    await act(async () => pressKey(search!, "Enter"));
    expect(results[0]?.getAttribute("aria-current")).toBe("location");
    await act(async () => pressKey(search!, "Enter"));
    expect(results[1]?.getAttribute("aria-current")).toBe("location");
    await act(async () =>
      search!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(results[0]?.getAttribute("aria-current")).toBe("location");
    expect(document.activeElement).toBe(search);

    await act(async () => results[0]?.focus());
    await act(async () => results[0]?.click());

    expect(container?.querySelector('[aria-label="指南搜索"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-guide-section-id="20"]'),
    ).not.toBeNull();
    expect(scroller.scrollTop).toBe(3_952);
    expect(document.activeElement).toBe(results[0]);
    expect(results[0]?.getAttribute("aria-current")).toBe("location");
    expect(selectedRange.current?.startContainer.textContent).toBe("精准");
    expect(selectedRange.current?.endContainer.textContent).toContain(
      "命中 中段",
    );

    searchLayoutShift = 300;
    const savesBeforeLayoutShift = savedScrollTops.length;
    const observersWhileAligning = resizeCallbacks.size;
    expect(observersWhileAligning).toBe(1);
    notifyResize();
    expect(scroller.scrollTop).toBe(4_252);
    await act(async () => {
      vi.advanceTimersByTime(399);
    });
    expect(savedScrollTops).toHaveLength(savesBeforeLayoutShift);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(savedScrollTops[savedScrollTops.length - 1]).toBe(4_252);

    const next = buttonNamed("下一个");
    next.focus();
    await act(async () => next.click());
    expect(scroller.scrollTop).toBeGreaterThan(4_252);
    expect(results[1]?.getAttribute("aria-current")).toBe("location");
    expect(document.activeElement).toBe(next);

    const previous = buttonNamed("上一个");
    await act(async () => previous.click());
    expect(scroller.scrollTop).toBe(4_252);
    expect(results[0]?.getAttribute("aria-current")).toBe("location");

    await act(async () => {
      vi.advanceTimersByTime(1_800);
    });
    expect(selectedRange.current).toBeNull();
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);

    searchLayoutShift = 500;
    notifyResize();
    expect(scroller.scrollTop).toBe(4_452);

    const image = container?.querySelector<HTMLImageElement>(
      '[data-guide-section-id="20"] img',
    );
    searchLayoutShift = 650;
    await act(async () => image?.dispatchEvent(new Event("load")));
    expect(scroller.scrollTop).toBe(4_602);
    searchLayoutShift = 700;
    await act(async () => image?.dispatchEvent(new Event("error")));
    expect(scroller.scrollTop).toBe(4_652);

    await act(async () => {
      vi.advanceTimersByTime(8_200);
    });
    // Layout observation is shared for the document's lifetime; only the search task stops.
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);
    searchLayoutShift = 900;
    notifyResize();
    expect(scroller.scrollTop).toBe(4_652);

    vi.mocked(window.getSelection).mockReturnValue(null);
    await act(async () => results[1]?.click());
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);

    await act(async () => results[0]?.click());
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);
    await act(async () => scroller.dispatchEvent(new Event("wheel")));
    expect(resizeCallbacks).toHaveLength(observersWhileAligning);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(search, guide.title);
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const titleResult = container?.querySelector<HTMLButtonElement>(
      'button[aria-label^="跳转到搜索结果"]',
    );
    expect(titleResult?.textContent).toContain(guide.title);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await act(async () => titleResult?.click());
    expect(scroller.scrollTop).toBe(0);

    await act(async () => buttonNamed("关闭搜索").click());
    blockRefresh = true;
    await act(async () => buttonNamed("更新").click());
    await flushMicrotasks();
    const reopenSearch = buttonNamed("搜索");
    expect(reopenSearch.disabled).toBe(false);
    await act(async () => reopenSearch.click());
    expect(container?.querySelector('[aria-label="指南搜索"]')).not.toBeNull();
    await act(async () =>
      container!.querySelector<HTMLInputElement>("input")!.focus(),
    );

    await act(async () => resolveRefresh({ ...guide, fetchedAt: 2 }));
    await flushMicrotasks();
    await flushFrame();
    expect(container?.querySelector('[aria-label="指南搜索"]')).toBeNull();
    expect(
      container
        ?.querySelector('[aria-label="指南目录"]')
        ?.getAttribute("data-expanded"),
    ).toBe("false");
    expect(document.activeElement).toBe(scroller);
    expect(document.activeElement?.closest("[inert], [hidden]")).toBeNull();
  });
});
