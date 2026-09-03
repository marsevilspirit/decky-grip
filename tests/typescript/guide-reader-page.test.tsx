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
import type { GuideImageFetcher } from "../../src/reader/image-hydrator";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import {
  ReaderSessionCache,
  type ReaderSessionBackend,
} from "../../src/reader/session-cache";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";

vi.mock("@decky/ui", () => {
  interface MockProps {
    children?: ReactNode;
    [key: string]: unknown;
  }

  const element = (tag: "button" | "div") =>
    forwardRef<HTMLElement, MockProps>((props, ref) => {
      const domProps = { ...props };
      const children = domProps.children as ReactNode;
      const onCancel = domProps.onCancel as
        ((event: CustomEvent) => void) | undefined;
      const onOptionsButton = domProps.onOptionsButton as
        | ((event: {
            detail: { button: number; is_repeat: boolean; source: number };
            preventDefault(): void;
            stopPropagation(): void;
          }) => void)
        | undefined;
      if (domProps.onOptionsActionDescription) {
        domProps["data-options-action"] = domProps.onOptionsActionDescription;
      }
      if (onCancel || onOptionsButton) {
        domProps.onKeyDown = (event: KeyboardEvent) => {
          if (event.key === "Options" && onOptionsButton) {
            onOptionsButton({
              detail: { button: 4, is_repeat: event.repeat, source: 0 },
              preventDefault: () => event.preventDefault(),
              stopPropagation: () => event.stopPropagation(),
            });
          } else if (event.key === "Escape" && onCancel) {
            onCancel(event as unknown as CustomEvent);
          }
        };
      }
      for (const name of [
        "children",
        "flow-children",
        "onButtonDown",
        "onCancel",
        "onGamepadDirection",
        "onOptionsActionDescription",
        "onOptionsButton",
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
    for (const callback of [...resizeCallbacks]) {
      callback([], {} as ResizeObserver);
    }
  };

  const mount = async (
    cache: ReaderSessionCache,
    fetchImage: GuideImageFetcher,
    scrollHeight: number,
    options: {
      loadGuideLibrary?: (appId: string) => Promise<GuideLibraryEntry[]>;
      onClose?: () => void;
      onSwitchGuide?: (identity: GuideIdentity) => Promise<void>;
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
          onClose={options.onClose ?? (() => undefined)}
          onRepairPositions={async () => ""}
          onSwitchGuide={options.onSwitchGuide ?? (async () => undefined)}
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

  const pressKey = (element: Element, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    element.dispatchEvent(event);
    return event;
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
    const scroller = await mount(cache, async () => null, 12_000);
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
    expect(buttonNamed("搜索").disabled).toBe(true);
    expect(buttonNamed("章节 1").disabled).toBe(true);

    await act(async () => {
      scroller.dispatchEvent(new Event("wheel", { bubbles: true }));
      scroller.scrollTop = 4_600;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      resolveRefresh({ ...guide, fetchedAt: 2 });
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

  it("keeps the reader headerless and the current guide non-interactive", async () => {
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
    expect(document.activeElement).toBe(buttonNamed("关闭"));
    const page = container?.firstElementChild as HTMLElement | null;
    const dialog = container?.querySelector<HTMLElement>(
      '[aria-label="切换指南"]',
    );
    expect(page?.style.paddingTop).toBe("40px");
    expect(dialog?.style.top).toBe("40px");
    expect(dialog?.classList.contains("grip-reader-guide-switcher")).toBe(true);
    const currentGuide = dialog?.querySelector('[aria-current="page"]');
    expect(currentGuide?.tagName).toBe("DIV");
    expect(currentGuide?.textContent).toContain("正在阅读 · 组件回归指南");
    expect(container?.querySelector(".grip-reader-guide-enter")).not.toBeNull();
    expect(
      container?.querySelector('button[aria-label^="正在阅读："]'),
    ).toBeNull();
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

    await act(async () => buttonNamed("关闭").click());
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
    expect(document.activeElement).toBe(buttonNamed("关闭"));
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

    buttonNamed("搜索").focus();
    await act(async () => {
      pressKey(buttonNamed("搜索"), "Options");
    });
    await flushFrame();
    await act(async () => buttonNamed("关闭").click());
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
      getGuide: async (guideId) => ({
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
        ?.querySelector<HTMLButtonElement>('button[aria-label="打开指南：20"]')
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
          'button[aria-label="打开指南：10000000000"]',
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
      getGuide: async (guideId) => {
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
        ?.querySelector<HTMLButtonElement>('button[aria-label="打开指南：20"]')
        ?.click();
    });
    await flushMicrotasks();

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "指南打开失败：offline",
    );
    expect(onSwitchGuide).not.toHaveBeenCalled();
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

    results[0]?.focus();
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
    expect(resizeCallbacks).toHaveLength(1);

    searchLayoutShift = 500;
    notifyResize();
    expect(scroller.scrollTop).toBe(4_452);

    const image = container?.querySelector<HTMLImageElement>(
      '[data-guide-section-id="20"] img',
    );
    searchLayoutShift = 650;
    image?.dispatchEvent(new Event("load"));
    expect(scroller.scrollTop).toBe(4_602);
    searchLayoutShift = 700;
    image?.dispatchEvent(new Event("error"));
    expect(scroller.scrollTop).toBe(4_652);

    await act(async () => {
      vi.advanceTimersByTime(8_200);
    });
    expect(resizeCallbacks).toHaveLength(0);
    searchLayoutShift = 900;
    notifyResize();
    expect(scroller.scrollTop).toBe(4_652);

    vi.mocked(window.getSelection).mockReturnValue(null);
    await act(async () => results[1]?.click());
    expect(resizeCallbacks).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(resizeCallbacks).toHaveLength(0);

    await act(async () => results[0]?.click());
    expect(resizeCallbacks).toHaveLength(1);
    scroller.dispatchEvent(new Event("wheel"));
    expect(resizeCallbacks).toHaveLength(0);

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
    expect(reopenSearch.disabled).toBe(true);
    await act(async () => reopenSearch.click());
    expect(container?.querySelector('[aria-label="指南搜索"]')).toBeNull();

    await act(async () => resolveRefresh(guide));
    await flushMicrotasks();
  });
});
