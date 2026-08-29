import { describe, expect, it, vi } from "vitest";

import {
  isImageNearViewport,
  ReaderImageHydrator,
  type CachedGuideImage,
} from "../../src/reader/image-hydrator";

function image(url: string) {
  const candidate = {
    dataset: { gripImageUrl: url } as DOMStringMap,
    isConnected: true,
    src: "",
    removeAttribute(name: string) {
      if (name === "src") {
        candidate.src = "";
      }
    },
  };
  return candidate;
}

function root(images: ReturnType<typeof image>[]) {
  return {
    querySelectorAll: () => images,
  } as unknown as HTMLElement;
}

const cached: CachedGuideImage = {
  mimeType: "image/png",
  base64: "aW1hZ2U=",
  fromCache: true,
  height: 1,
  width: 1,
};

describe("reader image hydration", () => {
  it("selects only images in or near the reader viewport", () => {
    const rect = (top: number, bottom: number) => ({
      getBoundingClientRect: () => ({ bottom, top }) as DOMRect,
    });
    const scroller = rect(100, 500);

    expect(isImageNearViewport(rect(-700, -600), scroller)).toBe(false);
    expect(isImageNearViewport(rect(-100, 0), scroller)).toBe(true);
    expect(isImageNearViewport(rect(500, 600), scroller)).toBe(true);
    expect(isImageNearViewport(rect(1_101, 1_201), scroller)).toBe(false);
  });

  it("loads inert URLs through a bounded RPC and assigns only blob URLs", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fetchImage = vi.fn(
      async () =>
        new Promise<CachedGuideImage>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(cached);
          });
        }),
    );
    const images = [
      image("https://a/1"),
      image("https://a/2"),
      image("https://a/3"),
    ];
    let nextBlob = 0;
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      2,
      () => `blob:grip-${++nextBlob}`,
      vi.fn(),
    );

    hydrator.hydrate(root(images));
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(3));
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await hydrator.waitForIdle();

    expect(images.map((candidate) => candidate.src)).toEqual([
      "blob:grip-1",
      "blob:grip-2",
      "blob:grip-3",
    ]);
    expect(fetchImage).toHaveBeenCalledWith("https://a/1", true);
    expect(images.every((candidate) => candidate.src.startsWith("blob:"))).toBe(
      true,
    );
  });

  it("does not refetch an image across progressive render passes", async () => {
    const target = image("https://a/image");
    const fetchImage = vi.fn(async () => cached);
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => "blob:cached",
      vi.fn(),
    );

    hydrator.hydrate(root([target]));
    await hydrator.waitForIdle();
    hydrator.hydrate(root([target]));
    await hydrator.waitForIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(target.src).toBe("blob:cached");
  });

  it("shares one RPC and one Blob URL across duplicate image nodes", async () => {
    const first = image("https://a/shared");
    const second = image("https://a/shared");
    const fetchImage = vi.fn(async () => cached);
    const makeObjectUrl = vi.fn(() => "blob:shared");
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      makeObjectUrl,
      vi.fn(),
    );

    hydrator.hydrate(root([first, second]));
    await hydrator.waitForIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(makeObjectUrl).toHaveBeenCalledOnce();
    expect(first.src).toBe("blob:shared");
    expect(second.src).toBe("blob:shared");
  });

  it("hydrates only selected nodes and bounds resident Blob bytes", async () => {
    const first = image("https://a/first");
    const second = image("https://a/second");
    const revoke = vi.fn();
    let blob = 0;
    const hydrator = new ReaderImageHydrator(
      vi.fn(async () => cached),
      1,
      () => `blob:${++blob}`,
      revoke,
      6,
      64,
    );

    hydrator.hydrate(root([first, second]), (candidate) => candidate === first);
    await hydrator.waitForIdle();
    expect(first.src).toBe("blob:1");
    expect(second.src).toBe("");

    hydrator.hydrate(
      root([first, second]),
      (candidate) => candidate === second,
    );
    await hydrator.waitForIdle();
    expect(first.src).toBe("");
    expect(second.src).toBe("blob:2");
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("rejects a single image whose decoded canvas exceeds the frontend quota", async () => {
    const target = image("https://a/large");
    const makeObjectUrl = vi.fn(() => "blob:large");
    const hydrator = new ReaderImageHydrator(
      vi.fn(async () => ({ ...cached, height: 3_000, width: 4_000 })),
      1,
      makeObjectUrl,
      vi.fn(),
    );

    hydrator.hydrate(root([target]));
    await hydrator.waitForIdle();

    expect(makeObjectUrl).not.toHaveBeenCalled();
    expect(target.dataset.gripImageState).toBe("unavailable");
  });

  it("defers a pinned image until another pin leaves the viewport", async () => {
    const first = image("https://a/first");
    const second = image("https://a/second");
    const revoke = vi.fn();
    let blob = 0;
    const hydrator = new ReaderImageHydrator(
      vi.fn(async () => cached),
      1,
      () => `blob:${++blob}`,
      revoke,
      6,
      64,
    );

    hydrator.setPinnedImages([first, second]);
    hydrator.hydrateImages([first, second]);
    await hydrator.waitForIdle();

    expect(first.src).toBe("blob:1");
    expect(first.dataset.gripImageState).toBe("ready");
    expect(second.src).toBe("");
    expect(second.dataset.gripImageState).toBe("deferred");
    expect(revoke).not.toHaveBeenCalled();

    hydrator.setPinnedImages([second]);
    hydrator.hydrateImages([second]);
    await hydrator.waitForIdle();

    expect(first.src).toBe("");
    expect(second.src).toBe("blob:2");
    expect(second.dataset.gripImageState).toBe("ready");
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("bounds distinct pending URLs and retries overflow as slots open", async () => {
    const images = [
      image("https://a/1"),
      image("https://a/2"),
      image("https://a/3"),
    ];
    const releases: Array<() => void> = [];
    const fetchImage = vi.fn(
      () =>
        new Promise<CachedGuideImage>((resolve) => {
          releases.push(() => resolve(cached));
        }),
    );
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => "blob:cached",
      vi.fn(),
      32 * 1024 * 1024,
      64,
      2,
    );

    hydrator.hydrateImages(images);
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(images[2].dataset.gripImageState).toBe("deferred");

    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await hydrator.waitForIdle();

    expect(fetchImage).toHaveBeenCalledTimes(3);
    expect(images[2].dataset.gripImageState).toBe("ready");
  });

  it("rehydrates a reused image node after a guide refresh clears blobs", async () => {
    const target = image("https://a/image");
    const fetchImage = vi.fn(async () => cached);
    let blob = 0;
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => `blob:cached-${++blob}`,
      vi.fn(),
    );

    hydrator.hydrate(root([target]));
    await hydrator.waitForIdle();
    hydrator.clear();
    hydrator.hydrate(root([target]));
    await hydrator.waitForIdle();

    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(target.src).toBe("blob:cached-2");
  });

  it("drops a late image result before creating a blob after cleanup", async () => {
    let resolveImage!: (value: CachedGuideImage) => void;
    const target = image("https://a/image");
    const revoke = vi.fn();
    const makeObjectUrl = vi.fn(() => "blob:late");
    const hydrator = new ReaderImageHydrator(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        }),
      1,
      makeObjectUrl,
      revoke,
    );

    hydrator.hydrate(root([target]));
    hydrator.clear();
    resolveImage(cached);
    await hydrator.waitForIdle();

    expect(target.src).toBe("");
    expect(makeObjectUrl).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
