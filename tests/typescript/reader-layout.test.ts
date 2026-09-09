// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderCheckpoint } from "../../src/reader/checkpoint";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import {
  ReaderImageHydrator,
  type CachedGuideImage,
  type GuideImageFetcher,
} from "../../src/reader/image-hydrator";
import { ReaderPositioning } from "../../src/reader/positioning";
import type { ReaderSessionSnapshot } from "../../src/reader/session-cache";
import {
  ReaderViewport,
  type ReaderViewportSnapshot,
} from "../../src/reader/viewport";

const snapshot: ReaderSessionSnapshot = {
  guide: {
    guideId: "20",
    title: "布局生命周期",
    author: "测试",
    sourceUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=20",
    fetchedAt: 1,
    fromCache: true,
    stale: false,
    sections: [
      { id: "1", title: "一", html: "<p>定位锚点</p>" },
      { id: "2", title: "二", html: "<p>后续章节</p>" },
    ],
  },
  position: {
    scrollTop: 800,
    sectionId: "1",
    anchorText: "定位锚点",
    anchorOffset: 0,
    updatedAt: 1,
  },
  positionWarning: null,
};

describe("shared reader layout lifecycle", () => {
  let scroller: HTMLElement;
  let content: HTMLElement;
  let textTop: number;
  let range: Range;
  let viewport: ReaderViewport;
  let positioning: ReaderPositioning;
  let checkpoint: ReaderCheckpoint;
  let cacheControl: ReaderImageCacheControl;
  let hydrator: ReaderImageHydrator;
  let fetchImage: ReturnType<typeof vi.fn<GuideImageFetcher>>;
  let makeObjectUrl: ReturnType<typeof vi.fn<() => string>>;
  let frames: Map<number, FrameRequestCallback>;
  let onLayout: ReturnType<typeof vi.fn<() => void>>;
  let onSnapshot: ReturnType<
    typeof vi.fn<(snapshot: ReaderViewportSnapshot) => void>
  >;
  let onInterrupted: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let resize: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let mutations: {
    callback: MutationCallback;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let resizeInstances: number;

  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(performance.now());
  };
  const layout = () => resize.callback([], resize as unknown as ResizeObserver);
  const callbacks = () => ({
    onOutcome: vi.fn(),
    onTimeout: vi.fn(),
    onStable: vi.fn(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    resizeInstances = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(readonly callback: ResizeObserverCallback) {
          resize = this;
          resizeInstances += 1;
        }
      },
    );
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(readonly callback: MutationCallback) {
          mutations = this;
        }
      },
    );
    scroller = document.createElement("div");
    content = document.createElement("div");
    content.innerHTML =
      '<section data-guide-section-id="1"><p>定位锚点</p></section>';
    scroller.append(content);
    document.body.append(scroller);
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 3000 });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    textTop = 800;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, textTop - scroller.scrollTop, 600, 24),
    );
    range = document.createRange();
    range.selectNodeContents(content.querySelector("p")!);
    fetchImage = vi.fn<GuideImageFetcher>(async () => null);
    makeObjectUrl = vi.fn(() => "blob:layout-test");
    hydrator = new ReaderImageHydrator(fetchImage, 1, makeObjectUrl, vi.fn());
    cacheControl = new ReaderImageCacheControl();
    checkpoint = new ReaderCheckpoint();
    onLayout = vi.fn(() => positioning.layoutChanged());
    onSnapshot = vi.fn();
    onInterrupted = vi.fn();
    viewport = new ReaderViewport(
      scroller,
      content,
      hydrator,
      cacheControl,
      onSnapshot,
      onLayout,
    );
    positioning = new ReaderPositioning(viewport, checkpoint, onInterrupted);
    viewport.syncSections();
  });

  afterEach(() => {
    positioning.dispose();
    viewport.dispose();
    hydrator.clear();
    scroller.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps one observer while restore survives timeout and search stops following layout after its deadline", async () => {
    const restored = callbacks();
    positioning.restore(snapshot, restored);
    frame();
    frame();
    expect(scroller.scrollTop).toBe(800);
    expect(checkpoint.canPersist).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restored.onTimeout).toHaveBeenCalledOnce();
    expect(restored.onOutcome).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(positioning.restoring).toBe(true);
    expect(checkpoint.canPersist).toBe(false);

    content.insertAdjacentHTML(
      "beforeend",
      '<section data-guide-section-id="2"><p>后续章节</p></section>',
    );
    textTop = 1000;
    viewport.syncSections();
    layout();
    expect(scroller.scrollTop).toBe(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(restored.onStable).toHaveBeenCalledOnce();
    expect(restored.onOutcome).toHaveBeenCalledOnce();
    expect(positioning.restoring).toBe(false);
    expect(checkpoint.canPersist).toBe(true);

    const onScroll = vi.fn(() => checkpoint.didScroll());
    textTop = 1500;
    positioning.search(range, onScroll);
    expect(scroller.scrollTop).toBe(1452);
    textTop = 1600;
    layout();
    expect(scroller.scrollTop).toBe(1552);
    await vi.advanceTimersByTimeAsync(10_000);
    textTop = 1700;
    layout();
    expect(scroller.scrollTop).toBe(1552);
    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(resizeInstances).toBe(1);
    expect(resize.observe.mock.calls).toEqual([[scroller], [content]]);
    expect(resize.disconnect).not.toHaveBeenCalled();
  });

  it("cancels operation timers and frames without allowing late callbacks to detach newer work", () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const deadline = () =>
      timeout.mock.calls
        .filter(([, delay]) => delay === 10_000)
        .pop()![0] as () => void;
    const first = callbacks();
    positioning.restore(snapshot, first);
    const oldFrame = [...frames.values()].pop()!;
    const oldDeadline = deadline();
    positioning.search(range, vi.fn());
    const searchDeadline = deadline();
    const searchedTop = scroller.scrollTop;
    oldFrame(0);
    oldDeadline();
    expect(scroller.scrollTop).toBe(searchedTop);
    expect(first.onTimeout).not.toHaveBeenCalled();
    expect(first.onOutcome).not.toHaveBeenCalled();

    positioning.restore(snapshot, callbacks());
    searchDeadline();
    positioning.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const pendingLayout = [...frames.values()];
    viewport.dispose();
    expect(frames.size).toBe(0);
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(mutations.disconnect).toHaveBeenCalledOnce();
    const notifications = onLayout.mock.calls.length;
    for (const callback of pendingLayout) callback(0);
    layout();
    mutations.callback([], mutations as unknown as MutationObserver);
    content.dispatchEvent(new Event("load"));
    scroller.dispatchEvent(new Event("wheel"));
    checkpoint.didScroll();
    expect(checkpoint.canPersist).toBe(false);
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(onLayout).toHaveBeenCalledTimes(notifications);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts positioning only for reader scroll intent and leaves shared observation alive", () => {
    positioning.restore(snapshot, callbacks());
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    content
      .querySelector("p")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(positioning.restoring).toBe(true);
    scroller.dispatchEvent(new Event("wheel"));
    expect(positioning.restoring).toBe(false);
    expect(onInterrupted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const onScroll = vi.fn();
    positioning.search(range, onScroll);
    const top = scroller.scrollTop;
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    textTop += 400;
    layout();
    expect(scroller.scrollTop).toBe(top);
    expect(onScroll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(resizeInstances).toBe(1);
    expect(resize.disconnect).not.toHaveBeenCalled();
  });

  it("keeps image cleanup paused across layout work and discards a pre-clear image response", async () => {
    let finish!: (value: CachedGuideImage) => void;
    const imageResult: CachedGuideImage = {
      mimeType: "image/png",
      base64: "aW1hZ2U=",
      width: 96,
      height: 96,
      fromCache: true,
    };
    fetchImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fetchImage.mockResolvedValue(imageResult);
    const image = document.createElement("img");
    image.dataset.gripImageUrl =
      "https://images.steamusercontent.com/layout.png";
    image.getBoundingClientRect = () => new DOMRect(0, 0, 96, 96);
    const section = document.createElement("section");
    section.append(image);
    content.append(section);
    viewport.syncSections();
    expect(fetchImage).toHaveBeenCalledOnce();
    const token = cacheControl.beginClear();
    viewport.measure();
    frame();
    finish(imageResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(makeObjectUrl).not.toHaveBeenCalled();
    expect(image.getAttribute("src")).toBeNull();
    expect(fetchImage).toHaveBeenCalledOnce();
    cacheControl.finishClear(token, true);
    layout();
    frame();
    expect(cacheControl.getSnapshot().paused).toBe(true);
    expect(fetchImage).toHaveBeenCalledOnce();
    cacheControl.resume();
    frame();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(image.getAttribute("src")).toBe("blob:layout-test");
  });
});
