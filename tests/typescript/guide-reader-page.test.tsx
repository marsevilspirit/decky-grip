// @vitest-environment happy-dom

import {
  act,
  createElement,
  forwardRef,
  type ChangeEventHandler,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuideLibraryEntry } from "../../src/backend";
import { GuideReaderPage } from "../../src/components/GuideReaderPage";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import {
  ReaderSessionCache,
  type ReaderSessionBackend,
} from "../../src/reader/session-cache";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";

vi.mock("@decky/ui", () => {
  interface MockProps {
    children?: ReactNode;
    [key: string]: unknown;
  }

  const element = (tag: "button" | "div") =>
    forwardRef<HTMLElement, MockProps>((props, ref) => {
      const domProps = { ...props };
      const children = domProps.children as ReactNode;
      for (const name of [
        "children",
        "flow-children",
        "onButtonDown",
        "onCancel",
        "onGamepadDirection",
        "preferredFocus",
      ]) {
        delete domProps[name];
      }
      return createElement(tag, { ...domProps, ref }, children);
    });

  return {
    Button: element("button"),
    Focusable: element("div"),
    GamepadButton: {
      BUMPER_LEFT: 9,
      BUMPER_RIGHT: 10,
      DIR_DOWN: 13,
      DIR_UP: 12,
    },
    Spinner: () => createElement("span", null, "loading"),
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
            ? '<p>图片章节</p><img data-grip-image-url="https://images.steamusercontent.com/ugc/test/image.png">'
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
  let activeScroller: HTMLElement | null;
  let root: Root | null;
  let container: HTMLDivElement | null;

  beforeEach(() => {
    vi.useFakeTimers();
    animationFrames = new Map();
    nextAnimationFrame = 1;
    resizeCallbacks = new Set();
    textSections = new WeakMap();
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
      return {
        selectNodeContents(node: Node) {
          selected = node;
        },
        getBoundingClientRect() {
          const sectionId = selected ? (textSections.get(selected) ?? 0) : 0;
          const absoluteTop = sectionId === 40 ? 9_000 : sectionId * 200;
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
    for (const callback of [...resizeCallbacks]) {
      callback([], {} as ResizeObserver);
    }
  };

  const mount = async (
    cache: ReaderSessionCache,
    fetchImage: () => Promise<null>,
    scrollHeight: number,
    options: {
      loadGuideLibrary?: (appId: string) => Promise<GuideLibraryEntry[]>;
      onBrowseSteamGuides?: (appId: string) => Promise<void>;
    } = {},
  ): Promise<HTMLElement> => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <GuideReaderPage
          cache={cache}
          fetchImage={fetchImage}
          imageCacheControl={new ReaderImageCacheControl()}
          loadGuideLibrary={options.loadGuideLibrary ?? (async () => [])}
          onBrowseSteamGuides={
            options.onBrowseSteamGuides ?? (async () => undefined)
          }
          onClose={() => undefined}
          onRepairPositions={async () => ""}
          onSwitchGuide={async () => undefined}
          performance={new ReaderPerformanceTracker()}
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

  it("keeps Steam discovery in the reader until the current position saves", async () => {
    const guide = guideFixture();
    const actions: string[] = [];
    let failSave = true;
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
      ) => {
        if (failSave) {
          actions.push("save failed");
          throw new Error("disk full");
        }
        actions.push("save");
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
    const browse = vi.fn(async (appId: string) => {
      actions.push(`browse ${appId}`);
    });
    await mount(cache, async () => null, 12_000, {
      onBrowseSteamGuides: browse,
    });

    await act(async () => buttonNamed("切换指南").click());
    await flushFrame();
    expect(document.activeElement).toBe(buttonNamed("关闭"));

    await act(async () => buttonNamed("查找更多 Steam 指南").click());
    await flushMicrotasks();
    expect(browse).not.toHaveBeenCalled();
    expect(container?.textContent).toContain(
      "当前指南位置保存失败，未打开 Steam 指南。",
    );
    const saveAlert = container?.querySelector('[role="alert"]');
    expect(saveAlert?.getAttribute("aria-hidden")).toBe("true");
    expect(saveAlert?.hasAttribute("inert")).toBe(true);

    failSave = false;
    await act(async () => buttonNamed("查找更多 Steam 指南").click());
    await flushMicrotasks();
    expect(browse).toHaveBeenCalledWith(identity.appId);
    expect(actions).toEqual([
      "save failed",
      "save",
      `browse ${identity.appId}`,
    ]);
  });

  it("keeps an active guide filter available when the library shrinks", async () => {
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
      favorite: false,
      cache: null,
    };
    const otherGuide: GuideLibraryEntry = {
      appId: identity.appId,
      guideId: "123",
      updatedAt: 1,
      favorite: true,
      cache: {
        title: "另一篇指南",
        author: "另一位作者",
        fetchedAt: 1,
        sectionTitle: null,
        stale: false,
      },
    };
    let library = [currentGuide, otherGuide];
    await mount(cache, async () => null, 12_000, {
      loadGuideLibrary: async () => library,
    });

    await act(async () => buttonNamed("切换指南").click());
    await flushMicrotasks();
    const filter = container?.querySelector<HTMLInputElement>(
      'input[aria-label="筛选指南"]',
    );
    expect(filter).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(filter, "另一篇");
      filter?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => buttonNamed("关闭").click());
    library = [currentGuide];
    await act(async () => buttonNamed("切换指南").click());
    await flushMicrotasks();

    expect(
      container?.querySelector<HTMLInputElement>('input[aria-label="筛选指南"]')
        ?.value,
    ).toBe("另一篇");
    expect(container?.textContent).toContain("没有匹配的指南。");
  });

  it("does not browse after the switcher closes while save is pending", async () => {
    const guide = guideFixture();
    let resolveSave!: (position: ReaderPosition) => void;
    const save = vi.fn(
      () =>
        new Promise<ReaderPosition>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const backend: ReaderSessionBackend = {
      getCachedGuide: async () => guide,
      getGuide: async () => guide,
      getReaderPosition: async () => null,
      saveReaderPosition: save,
    };
    const cache = new ReaderSessionCache(backend);
    await cache.load(identity);
    const browse = vi.fn(async () => undefined);
    await mount(cache, async () => null, 12_000, {
      onBrowseSteamGuides: browse,
    });

    await act(async () => buttonNamed("切换指南").click());
    await flushMicrotasks();
    await act(async () => buttonNamed("查找更多 Steam 指南").click());
    await flushMicrotasks();
    expect(save).toHaveBeenCalledOnce();
    expect(browse).not.toHaveBeenCalled();

    await act(async () => buttonNamed("关闭").click());
    await act(async () => {
      resolveSave({
        scrollTop: 0,
        sectionId: "1",
        anchorText: "重复锚点",
        anchorOffset: 0,
        updatedAt: 2,
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(browse).not.toHaveBeenCalled();
  });
});
