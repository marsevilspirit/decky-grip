// @vitest-environment happy-dom

import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
          loadGuideLibrary={async () => []}
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
});
