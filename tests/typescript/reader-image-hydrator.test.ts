import { describe, expect, it, vi } from "vitest";

import {
  ReaderImageHydrator,
  type CachedGuideImage,
} from "../../src/reader/image-hydrator";

function image(url: string) {
  const candidate = {
    dataset: { gripImageUrl: url } as DOMStringMap,
    isConnected: true,
    src: "",
    width: 0,
    height: 0,
    removeAttribute(name: string) {
      if (name === "src") {
        candidate.src = "";
      }
    },
  };
  return candidate;
}

const cached: CachedGuideImage = {
  mimeType: "image/png",
  base64: "aW1hZ2U=",
  fromCache: true,
  height: 1,
  width: 1,
};

describe("reader image hydration", () => {
  it("retries only the failed URL, guards double presses and replaces failed decode blobs", async () => {
    const failed = image("https://a/failed");
    const healthy = image("https://a/healthy");
    let release!: (result: CachedGuideImage) => void;
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cached)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(cached);
    let nextBlob = 0;
    const revoke = vi.fn();
    const hydrator = new ReaderImageHydrator(
      fetchImage,
      1,
      () => `blob:${++nextBlob}`,
      revoke,
    );
    hydrator.hydrateImages([failed, healthy]);
    await vi.waitFor(() => expect(healthy.src).toBe("blob:1"));
    expect(failed.dataset.gripImageState).toBe("unavailable");
    hydrator.hydrateImages([failed]);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    hydrator.retryImage(failed);
    hydrator.retryImage(failed);
    expect(fetchImage).toHaveBeenCalledTimes(3);
    expect(failed.dataset.gripImageState).toBe("loading");
    release(cached);
    await vi.waitFor(() => expect(failed.src).toBe("blob:2"));
    expect(healthy.src).toBe("blob:1");
    failed.dataset.gripImageState = "unavailable";
    hydrator.retryImage(failed);
    await vi.waitFor(() => expect(failed.src).toBe("blob:3"));
    expect(revoke).toHaveBeenCalledWith("blob:2");
    expect(healthy.src).toBe("blob:1");
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([
      "https://a/failed",
      "https://a/healthy",
      "https://a/failed",
      "https://a/failed",
    ]);
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

    hydrator.hydrateImages(images);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(3));
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await vi.waitFor(() =>
      expect(
        images.every((candidate) => candidate.src.startsWith("blob:")),
      ).toBe(true),
    );

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

    hydrator.hydrateImages([target]);
    await vi.waitFor(() => expect(target.src).toBe("blob:cached"));
    hydrator.hydrateImages([target]);

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

    hydrator.hydrateImages([first, second]);
    await vi.waitFor(() => expect(second.src).toBe("blob:shared"));

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

    hydrator.hydrateImages([first]);
    await vi.waitFor(() => expect(first.src).toBe("blob:1"));
    expect(first.src).toBe("blob:1");
    expect(second.src).toBe("");

    hydrator.hydrateImages([second]);
    await vi.waitFor(() => expect(second.src).toBe("blob:2"));
    expect(first.src).toBe("");
    expect(second.src).toBe("blob:2");
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("rejects a single image whose decoded canvas exceeds the frontend quota", async () => {
    const target = image("https://a/large");
    const makeObjectUrl = vi.fn(() => "blob:large");
    const hydrator = new ReaderImageHydrator(
      vi.fn(async () => ({ ...cached, height: 4_097, width: 4_096 })),
      1,
      makeObjectUrl,
      vi.fn(),
    );

    hydrator.hydrateImages([target]);
    await vi.waitFor(() =>
      expect(target.dataset.gripImageState).toBe("unavailable"),
    );

    expect(makeObjectUrl).not.toHaveBeenCalled();
    expect(target.dataset.gripImageState).toBe("unavailable");
  });

  it("displays the largest backend-accepted image and preserves dimensions after eviction", async () => {
    const target = image("https://a/large");
    const other = image("https://a/other");
    const hydrator = new ReaderImageHydrator(
      vi.fn(async () => ({ ...cached, height: 4_096, width: 4_096 })),
      1,
      () => "blob:large",
      vi.fn(),
    );
    hydrator.hydrateImages([target]);
    await vi.waitFor(() => expect(target.src).toBe("blob:large"));
    hydrator.hydrateImages([other]);
    await vi.waitFor(() => expect(other.src).toBe("blob:large"));
    expect(target.src).toBe("");
    expect(target.width).toBe(4_096);
    expect(target.height).toBe(4_096);
    hydrator.clear();
    expect(other.width).toBe(4_096);
    expect(other.height).toBe(4_096);
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
    await vi.waitFor(() =>
      expect(second.dataset.gripImageState).toBe("deferred"),
    );

    expect(first.src).toBe("blob:1");
    expect(first.dataset.gripImageState).toBe("ready");
    expect(second.src).toBe("");
    expect(second.dataset.gripImageState).toBe("deferred");
    expect(revoke).not.toHaveBeenCalled();

    hydrator.setPinnedImages([second]);
    hydrator.hydrateImages([second]);
    await vi.waitFor(() => expect(second.src).toBe("blob:2"));

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
    await vi.waitFor(() =>
      expect(images[2].dataset.gripImageState).toBe("ready"),
    );

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

    hydrator.hydrateImages([target]);
    await vi.waitFor(() => expect(target.src).toBe("blob:cached-1"));
    hydrator.clear();
    hydrator.hydrateImages([target]);
    await vi.waitFor(() => expect(target.src).toBe("blob:cached-2"));

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

    hydrator.hydrateImages([target]);
    hydrator.clear();
    resolveImage(cached);
    await Promise.resolve();
    await Promise.resolve();

    expect(target.src).toBe("");
    expect(makeObjectUrl).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
