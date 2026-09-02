import { describe, expect, it, vi } from "vitest";

import type { CapturedReaderPosition } from "../../src/reader/anchor";
import {
  ReaderSessionCache,
  retainGuideForStaleRefresh,
  type ReaderSessionBackend,
} from "../../src/reader/session-cache";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";

const identity: GuideIdentity = { appId: "1113000", guideId: "3414883877" };
const guideKey = "1113000:3414883877";

function guide(title: string): DownloadedGuide {
  return {
    guideId: identity.guideId,
    title,
    author: "Guide author",
    sourceUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${identity.guideId}`,
    fetchedAt: 100,
    fromCache: true,
    stale: false,
    sections: [{ id: "10", title: "Start", html: "<p>Text</p>" }],
  };
}

function readerPosition(scrollTop: number, updatedAt = 200): ReaderPosition {
  return {
    scrollTop,
    sectionId: "10",
    anchorText: "Text",
    anchorOffset: 12,
    updatedAt,
  };
}

function capturedPosition(scrollTop: number): CapturedReaderPosition {
  return {
    scrollTop,
    sectionId: "10",
    anchorText: "Text",
    anchorOffset: 12,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function backend(overrides: Partial<ReaderSessionBackend> = {}) {
  const defaults: ReaderSessionBackend = {
    getCachedGuide: vi.fn(async () => guide("Preloaded guide")),
    getGuide: vi.fn(async () => guide("Cached guide")),
    getReaderPosition: vi.fn(async () => readerPosition(120)),
    saveReaderPosition: vi.fn(async (_key, scrollTop) =>
      readerPosition(scrollTop, 300),
    ),
  };
  return { ...defaults, ...overrides };
}

describe("ReaderSessionCache", () => {
  it("retains the mounted guide object for a stale force-refresh fallback", () => {
    const existing = {
      guide: guide("Mounted guide"),
      position: readerPosition(120),
      positionWarning: null,
    };
    const refreshed = {
      guide: { ...guide("Stale backend copy"), stale: true },
      position: readerPosition(900),
      positionWarning: "position warning",
    };

    const displayed = retainGuideForStaleRefresh(existing, refreshed, true);

    expect(displayed.guide).toBe(existing.guide);
    expect(displayed.position).toBe(refreshed.position);
    expect(displayed.positionWarning).toBe("position warning");
    expect(retainGuideForStaleRefresh(existing, refreshed, false)).toBe(
      refreshed,
    );
  });

  it("provides a synchronous peek after loading a guide and position", async () => {
    const injected = backend();
    const cache = new ReaderSessionCache(injected);

    expect(cache.peek(identity)).toBeNull();
    const loaded = await cache.load(identity);

    expect(cache.peek(identity)).toBe(loaded);
    await expect(cache.load(identity)).resolves.toBe(loaded);
    expect(injected.getGuide).toHaveBeenCalledOnce();
    expect(injected.getGuide).toHaveBeenCalledWith(identity.guideId, false);
    expect(injected.getReaderPosition).toHaveBeenCalledWith(guideKey);
  });

  it("records reader access even when the position did not change", async () => {
    const injected = backend();
    const cache = new ReaderSessionCache(injected);
    const loaded = await cache.load(identity);
    const firstOpen = { appId: identity.appId, guideId: "3414883878" };
    const handoff = capturedPosition(333);

    await cache.rememberAccess(identity, loaded.position);
    await cache.rememberAccess(firstOpen, handoff);

    expect(injected.saveReaderPosition).toHaveBeenNthCalledWith(
      1,
      guideKey,
      120,
      "10",
      "Text",
      12,
    );
    expect(injected.saveReaderPosition).toHaveBeenNthCalledWith(
      2,
      `${firstOpen.appId}:${firstOpen.guideId}`,
      handoff.scrollTop,
      handoff.sectionId,
      handoff.anchorText,
      handoff.anchorOffset,
    );
  });

  it("persists reader access in open order across different guides", async () => {
    const firstSave = deferred<ReaderPosition>();
    const secondIdentity = { appId: identity.appId, guideId: "3414883878" };
    const saveReaderPosition = vi.fn<
      ReaderSessionBackend["saveReaderPosition"]
    >((key, scrollTop) =>
      key === guideKey
        ? firstSave.promise
        : Promise.resolve(readerPosition(scrollTop, 302)),
    );
    const cache = new ReaderSessionCache(backend({ saveReaderPosition }));

    const first = cache.rememberAccess(identity, null);
    const second = cache.rememberAccess(secondIdentity, null);
    await Promise.resolve();

    expect(saveReaderPosition).toHaveBeenCalledTimes(1);
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      0,
      null,
      null,
      0,
    );

    firstSave.resolve(readerPosition(0, 301));
    await Promise.all([first, second]);
    expect(saveReaderPosition).toHaveBeenNthCalledWith(
      2,
      `${secondIdentity.appId}:${secondIdentity.guideId}`,
      0,
      null,
      null,
      0,
    );
  });

  it("reserves access before a newer position save for the same guide", async () => {
    const blocker = { appId: "222", guideId: "20" };
    const blockerKey = `${blocker.appId}:${blocker.guideId}`;
    const blockedSave = deferred<ReaderPosition>();
    const saveReaderPosition = vi.fn<
      ReaderSessionBackend["saveReaderPosition"]
    >((key, scrollTop) =>
      key === blockerKey
        ? blockedSave.promise
        : Promise.resolve(readerPosition(scrollTop, 302)),
    );
    const cache = new ReaderSessionCache(backend({ saveReaderPosition }));
    const loaded = await cache.load(identity);

    const blocking = cache.rememberAccess(blocker, null);
    const staleAccess = cache.rememberAccess(identity, loaded.position);
    const latestSave = cache.savePosition(identity, capturedPosition(800));
    await Promise.resolve();

    blockedSave.resolve(readerPosition(0, 301));
    await Promise.all([blocking, staleAccess, latestSave]);

    expect(
      saveReaderPosition.mock.calls
        .filter(([key]) => key === guideKey)
        .map(([, scrollTop]) => scrollTop),
    ).toEqual([120, 800]);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(800);
  });

  it("coalesces concurrent loads for the same guide key", async () => {
    const pendingGuide = deferred<DownloadedGuide>();
    const pendingPosition = deferred<ReaderPosition | null>();
    const injected = backend({
      getGuide: vi.fn(() => pendingGuide.promise),
      getReaderPosition: vi.fn(() => pendingPosition.promise),
    });
    const cache = new ReaderSessionCache(injected);

    const first = cache.load(identity);
    const second = cache.load(identity);

    expect(second).toBe(first);
    expect(injected.getGuide).toHaveBeenCalledOnce();
    expect(injected.getReaderPosition).toHaveBeenCalledOnce();
    pendingGuide.resolve(guide("Loaded once"));
    pendingPosition.resolve(readerPosition(220));
    await expect(first).resolves.toEqual({
      guide: expect.objectContaining({ title: "Loaded once" }),
      position: expect.objectContaining({ scrollTop: 220 }),
      positionWarning: null,
    });
  });

  it("preloads only through the cache-only backend endpoint", async () => {
    const injected = backend({
      getCachedGuide: vi.fn(async () => guide("Preloaded guide")),
    });
    const cache = new ReaderSessionCache(injected);

    const preloaded = await cache.preload(identity);

    expect(preloaded?.guide.title).toBe("Preloaded guide");
    expect(cache.peek(identity)).toBe(preloaded);
    expect(injected.getCachedGuide).toHaveBeenCalledWith(identity.guideId);
    expect(injected.getGuide).not.toHaveBeenCalled();
    expect(injected.getReaderPosition).toHaveBeenCalledWith(guideKey);
  });

  it("keeps guide content usable when the reader position is corrupt", async () => {
    const injected = backend({
      getReaderPosition: vi.fn(async () => {
        throw new Error("reader_positions.json is malformed");
      }),
    });
    const cache = new ReaderSessionCache(injected);

    const loaded = await cache.load(identity);

    expect(loaded.guide.title).toBe("Cached guide");
    expect(loaded.position).toBeNull();
    expect(loaded.positionWarning).toBe(
      "阅读位置加载失败，正文仍可使用：reader_positions.json is malformed",
    );
    expect(cache.peek(identity)).toBe(loaded);
  });

  it("keeps a cache-only preload usable when its position read fails", async () => {
    const injected = backend({
      getReaderPosition: vi.fn(async () => {
        throw new Error("position unavailable");
      }),
    });
    const cache = new ReaderSessionCache(injected);

    const preloaded = await cache.preload(identity);

    expect(preloaded?.guide.title).toBe("Preloaded guide");
    expect(preloaded?.position).toBeNull();
    expect(preloaded?.positionWarning).toContain("position unavailable");
  });

  it("keeps a staged handoff without writing into a corrupt position store", async () => {
    const injected = backend({
      getReaderPosition: vi.fn(async () => {
        throw new Error("corrupt position store");
      }),
    });
    const cache = new ReaderSessionCache(injected);
    cache.stageHandoff(identity, capturedPosition(444));

    const loaded = await cache.load(identity);

    expect(loaded.position?.scrollTop).toBe(444);
    expect(loaded.positionWarning).toContain("corrupt position store");
    expect(injected.saveReaderPosition).not.toHaveBeenCalled();
  });

  it("keeps the last known position when a refresh position read fails", async () => {
    const getReaderPosition = vi
      .fn<ReaderSessionBackend["getReaderPosition"]>()
      .mockResolvedValueOnce(readerPosition(120))
      .mockRejectedValueOnce(new Error("temporary read failure"));
    const cache = new ReaderSessionCache(backend({ getReaderPosition }));
    const first = await cache.load(identity);

    const refreshed = await cache.load(identity, { forceRefresh: true });

    expect(refreshed.position).toBe(first.position);
    expect(refreshed.positionWarning).toContain("temporary read failure");
  });

  it("retries only the failed position without refetching guide content", async () => {
    const getReaderPosition = vi
      .fn<ReaderSessionBackend["getReaderPosition"]>()
      .mockRejectedValueOnce(new Error("corrupt position"))
      .mockResolvedValueOnce(readerPosition(321));
    const injected = backend({ getReaderPosition });
    const cache = new ReaderSessionCache(injected);
    const first = await cache.load(identity);

    const retried = await cache.retryPosition(identity);

    expect(first.guide).toBe(retried.guide);
    expect(retried.position?.scrollTop).toBe(321);
    expect(retried.positionWarning).toBeNull();
    expect(injected.getGuide).toHaveBeenCalledOnce();
    expect(getReaderPosition).toHaveBeenCalledTimes(2);
  });

  it("reuses a completed preload for a normal foreground load", async () => {
    const injected = backend();
    const cache = new ReaderSessionCache(injected);
    const preloaded = await cache.preload(identity);

    const loaded = await cache.load(identity);

    expect(loaded).toBe(preloaded);
    expect(injected.getGuide).not.toHaveBeenCalled();
  });

  it("coalesces concurrent cache-only preloads", async () => {
    const pendingPreload = deferred<DownloadedGuide | null>();
    const injected = backend({
      getCachedGuide: vi.fn(() => pendingPreload.promise),
    });
    const cache = new ReaderSessionCache(injected);

    const first = cache.preload(identity);
    const second = cache.preload(identity);

    expect(second).toBe(first);
    expect(injected.getCachedGuide).toHaveBeenCalledOnce();
    pendingPreload.resolve(guide("Preloaded once"));
    await first;
  });

  it("does not fetch or remember a cache-only preload miss", async () => {
    const injected = backend({
      getCachedGuide: vi.fn(async () => null),
    });
    const cache = new ReaderSessionCache(injected);

    await expect(cache.preload(identity)).resolves.toBeNull();

    expect(cache.peek(identity)).toBeNull();
    expect(injected.getGuide).not.toHaveBeenCalled();
    expect(injected.getReaderPosition).not.toHaveBeenCalled();
  });

  it("starts a foreground load without waiting for an active preload", async () => {
    const pendingPreload = deferred<DownloadedGuide | null>();
    const injected = backend({
      getCachedGuide: vi.fn(() => pendingPreload.promise),
      getGuide: vi.fn(async () => guide("Foreground guide")),
    });
    const cache = new ReaderSessionCache(injected);
    const preloading = cache.preload(identity);

    const foreground = await cache.load(identity);

    expect(foreground.guide.title).toBe("Foreground guide");
    expect(injected.getGuide).toHaveBeenCalledWith(identity.guideId, false);
    pendingPreload.resolve(guide("Late preload"));
    await expect(preloading).resolves.toBe(foreground);
    expect(cache.peek(identity)).toBe(foreground);
  });

  it("loads another guide without waiting for an active preload", async () => {
    const pendingPreload = deferred<DownloadedGuide | null>();
    const secondIdentity = { appId: "1113000", guideId: "3414883878" };
    const injected = backend({
      getCachedGuide: vi.fn(() => pendingPreload.promise),
      getGuide: vi.fn(async () => guide("Foreground B")),
    });
    const cache = new ReaderSessionCache(injected);
    const preloading = cache.preload(identity);

    const foreground = await cache.load(secondIdentity);

    expect(foreground.guide.title).toBe("Foreground B");
    expect(injected.getGuide).toHaveBeenCalledWith(
      secondIdentity.guideId,
      false,
    );
    pendingPreload.resolve(null);
    await preloading;
  });

  it("keeps positions independent while switching A to B and back", async () => {
    const secondIdentity = { appId: identity.appId, guideId: "3414883878" };
    const positions = new Map<string, ReaderPosition>([
      [guideKey, readerPosition(100)],
      [
        `${secondIdentity.appId}:${secondIdentity.guideId}`,
        readerPosition(200),
      ],
    ]);
    const saveReaderPosition = vi.fn<
      ReaderSessionBackend["saveReaderPosition"]
    >(async (key, scrollTop, sectionId, anchorText, anchorOffset) => {
      const saved = {
        scrollTop,
        sectionId,
        anchorText,
        anchorOffset,
        updatedAt: 300,
      };
      positions.set(key, saved);
      return saved;
    });
    const cache = new ReaderSessionCache(
      backend({
        getGuide: vi.fn(async (guideId) => ({
          ...guide(`Guide ${guideId}`),
          guideId,
        })),
        getReaderPosition: vi.fn(async (key) => positions.get(key) ?? null),
        saveReaderPosition,
      }),
    );

    await cache.load(identity);
    await cache.savePosition(identity, capturedPosition(111));
    await cache.load(secondIdentity);
    await cache.savePosition(secondIdentity, capturedPosition(222));

    expect((await cache.load(identity)).position?.scrollTop).toBe(111);
    expect(cache.peek(secondIdentity)?.position?.scrollTop).toBe(222);
  });

  it("never resurrects a late preload after a newer snapshot is evicted", async () => {
    const pendingPreload = deferred<DownloadedGuide | null>();
    const secondIdentity = { appId: "1113000", guideId: "3414883878" };
    const thirdIdentity = { appId: "1113000", guideId: "3414883879" };
    const injected = backend({
      getCachedGuide: vi.fn(() => pendingPreload.promise),
      getGuide: vi.fn(async (guideId) => guide(`Foreground ${guideId}`)),
    });
    const cache = new ReaderSessionCache(injected);
    const oldPreload = cache.preload(identity);

    await cache.load(identity);
    await cache.load(secondIdentity);
    await cache.load(thirdIdentity);
    expect(cache.peek(identity)).toBeNull();

    pendingPreload.resolve(guide("Old A"));
    await oldPreload;

    expect(cache.peek(identity)).toBeNull();
    expect(cache.peek(secondIdentity)).not.toBeNull();
    expect(cache.peek(thirdIdentity)).not.toBeNull();
  });

  it("force refreshes a cache-only preloaded snapshot", async () => {
    const injected = backend();
    const cache = new ReaderSessionCache(injected);
    await cache.preload(identity);

    await cache.load(identity, { forceRefresh: true });

    expect(injected.getGuide).toHaveBeenCalledOnce();
    expect(injected.getGuide).toHaveBeenCalledWith(identity.guideId, true);
  });

  it("does not persist a staged handoff during background preloading", async () => {
    const injected = backend({
      getReaderPosition: vi.fn(async () => null),
    });
    const cache = new ReaderSessionCache(injected);
    cache.stageHandoff(identity, capturedPosition(640));

    const preloaded = await cache.preload(identity);
    await Promise.resolve();

    expect(preloaded?.position?.scrollTop).toBe(640);
    expect(injected.saveReaderPosition).not.toHaveBeenCalled();

    const loaded = await cache.load(identity);
    await Promise.resolve();

    expect(loaded.position?.scrollTop).toBe(640);
    expect(injected.saveReaderPosition).toHaveBeenCalledOnce();
  });

  it("does not repopulate after clear when a preload finishes late", async () => {
    const pendingPreload = deferred<DownloadedGuide | null>();
    const cache = new ReaderSessionCache(
      backend({ getCachedGuide: vi.fn(() => pendingPreload.promise) }),
    );
    const preloading = cache.preload(identity);

    cache.clear();
    pendingPreload.resolve(guide("Late preload"));
    await preloading;

    expect(cache.peek(identity)).toBeNull();
  });

  it("does not let an old preload clear a newer same-key preload", async () => {
    const oldGuide = deferred<DownloadedGuide | null>();
    const newGuide = deferred<DownloadedGuide | null>();
    const getCachedGuide = vi
      .fn<ReaderSessionBackend["getCachedGuide"]>()
      .mockImplementationOnce(() => oldGuide.promise)
      .mockImplementationOnce(() => newGuide.promise);
    const cache = new ReaderSessionCache(backend({ getCachedGuide }));
    const oldPreload = cache.preload(identity);

    cache.clear();
    const newPreload = cache.preload(identity);
    oldGuide.resolve(guide("Old preload"));
    await oldPreload;

    expect(cache.preload(identity)).toBe(newPreload);
    newGuide.resolve(guide("New preload"));
    await newPreload;
    expect(cache.peek(identity)?.guide.title).toBe("New preload");
  });

  it("keeps the previous peek visible until a force refresh succeeds", async () => {
    const refreshGuide = deferred<DownloadedGuide>();
    const refreshPosition = deferred<ReaderPosition | null>();
    const getGuide = vi
      .fn<ReaderSessionBackend["getGuide"]>()
      .mockResolvedValueOnce(guide("Old guide"))
      .mockImplementationOnce(() => refreshGuide.promise);
    const getReaderPosition = vi
      .fn<ReaderSessionBackend["getReaderPosition"]>()
      .mockResolvedValueOnce(readerPosition(100))
      .mockImplementationOnce(() => refreshPosition.promise);
    const cache = new ReaderSessionCache(
      backend({ getGuide, getReaderPosition }),
    );
    const oldSnapshot = await cache.load(identity);

    const refreshing = cache.load(identity, { forceRefresh: true });

    expect(cache.peek(identity)).toBe(oldSnapshot);
    expect(getGuide).toHaveBeenLastCalledWith(identity.guideId, true);
    refreshGuide.resolve(guide("New guide"));
    await Promise.resolve();
    expect(cache.peek(identity)).toBe(oldSnapshot);
    refreshPosition.resolve(readerPosition(900));
    const refreshed = await refreshing;
    expect(cache.peek(identity)).toBe(refreshed);
    expect(refreshed.guide.title).toBe("New guide");
    expect(refreshed.position?.scrollTop).toBe(900);
  });

  it("does not let a late refresh or retry overwrite a newer save", async () => {
    for (const operation of ["refresh", "retry"] as const) {
      const latePosition = deferred<ReaderPosition | null>();
      const getReaderPosition = vi
        .fn<ReaderSessionBackend["getReaderPosition"]>()
        .mockResolvedValueOnce(readerPosition(100))
        .mockImplementationOnce(() => latePosition.promise);
      const cache = new ReaderSessionCache(backend({ getReaderPosition }));
      await cache.load(identity);

      const reading =
        operation === "refresh"
          ? cache.load(identity, { forceRefresh: true })
          : cache.retryPosition(identity);
      const saving = cache.savePosition(identity, capturedPosition(777));
      latePosition.resolve(readerPosition(100));
      await saving;
      const result = await reading;

      expect(result.position?.scrollTop).toBe(777);
      expect(cache.peek(identity)?.position?.scrollTop).toBe(777);
    }
  });

  it("adopts a staged native handoff only after the backend reports no position", async () => {
    const pendingSave = deferred<ReaderPosition>();
    const saveReaderPosition = vi.fn(() => pendingSave.promise);
    const cache = new ReaderSessionCache(
      backend({
        getReaderPosition: vi.fn(async () => null),
        saveReaderPosition,
      }),
    );
    const handoff = capturedPosition(640);
    cache.stageHandoff(identity, handoff);

    const loaded = await cache.load(identity);

    expect(loaded.position).toEqual({ ...handoff, updatedAt: 0 });
    expect(cache.peek(identity)).toBe(loaded);
    expect(saveReaderPosition).toHaveBeenCalledWith(
      guideKey,
      640,
      "10",
      "Text",
      12,
    );
    pendingSave.resolve(readerPosition(640, 700));
    await pendingSave.promise;
    await Promise.resolve();
    expect(cache.peek(identity)?.position).toEqual(readerPosition(640, 700));
  });

  it("discards a staged handoff when the backend already has a position", async () => {
    const injected = backend({
      getReaderPosition: vi.fn(async () => readerPosition(480)),
    });
    const cache = new ReaderSessionCache(injected);
    cache.stageHandoff(identity, capturedPosition(999));

    const loaded = await cache.load(identity);

    expect(loaded.position?.scrollTop).toBe(480);
    expect(injected.saveReaderPosition).not.toHaveBeenCalled();
  });

  it("keeps and retries an adopted handoff when its asynchronous save fails", async () => {
    const persisted = readerPosition(510, 900);
    const saveReaderPosition = vi
      .fn<ReaderSessionBackend["saveReaderPosition"]>()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(persisted);
    const cache = new ReaderSessionCache(
      backend({
        getReaderPosition: vi.fn(async () => null),
        saveReaderPosition,
      }),
    );
    cache.stageHandoff(identity, capturedPosition(510));

    const loaded = await cache.load(identity);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loaded.position?.scrollTop).toBe(510);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(510);
    expect(saveReaderPosition).toHaveBeenCalledOnce();

    await cache.load(identity);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(saveReaderPosition).toHaveBeenCalledTimes(2);
    expect(cache.peek(identity)?.position).toBe(persisted);
  });

  it("saves a reader position through the backend and updates the cache", async () => {
    const pendingSave = deferred<ReaderPosition>();
    const injected = backend({
      saveReaderPosition: vi.fn(() => pendingSave.promise),
    });
    const cache = new ReaderSessionCache(injected);
    await cache.load(identity);
    const captured = capturedPosition(777);

    const saving = cache.savePosition(identity, captured);

    expect(injected.saveReaderPosition).toHaveBeenCalledWith(
      guideKey,
      777,
      "10",
      "Text",
      12,
    );
    expect(cache.peek(identity)?.position).toEqual({
      ...captured,
      updatedAt: 0,
    });
    pendingSave.resolve(readerPosition(777, 300));
    const saved = await saving;
    expect(saved).toEqual(readerPosition(777, 300));
    expect(cache.peek(identity)?.position).toBe(saved);
  });

  it("persists same-guide saves in capture order across reader mounts", async () => {
    const firstSave = deferred<ReaderPosition>();
    const secondSave = deferred<ReaderPosition>();
    const saveReaderPosition = vi
      .fn<ReaderSessionBackend["saveReaderPosition"]>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const cache = new ReaderSessionCache(backend({ saveReaderPosition }));
    await cache.load(identity);

    const first = cache.savePosition(identity, capturedPosition(400));
    const second = cache.savePosition(identity, capturedPosition(800));

    expect(saveReaderPosition).toHaveBeenCalledTimes(1);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(800);
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      400,
      "10",
      "Text",
      12,
    );
    firstSave.resolve(readerPosition(400, 301));
    await first;
    await Promise.resolve();
    expect(saveReaderPosition).toHaveBeenCalledTimes(2);
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      800,
      "10",
      "Text",
      12,
    );
    secondSave.resolve(readerPosition(800, 302));
    await second;
    expect(cache.peek(identity)?.position).toEqual(readerPosition(800, 302));
  });

  it("waits for a pending save before retrying the stored position", async () => {
    const releaseSave = deferred<void>();
    let stored = readerPosition(100);
    const getReaderPosition = vi.fn(async () => stored);
    const saveReaderPosition = vi.fn(
      async (_key: string, scrollTop: number) => {
        await releaseSave.promise;
        stored = readerPosition(scrollTop, 301);
        return stored;
      },
    );
    const cache = new ReaderSessionCache(
      backend({ getReaderPosition, saveReaderPosition }),
    );
    await cache.load(identity);

    const saving = cache.savePosition(identity, capturedPosition(777));
    const retrying = cache.retryPosition(identity);

    expect(cache.peek(identity)?.position?.scrollTop).toBe(777);
    expect(getReaderPosition).toHaveBeenCalledOnce();
    releaseSave.resolve(undefined);
    await saving;
    const retried = await retrying;
    expect(getReaderPosition).toHaveBeenCalledTimes(2);
    expect(retried.position?.scrollTop).toBe(777);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(777);
  });

  it("keeps a direct save newer than a same-tick staged handoff", async () => {
    const stagedSave = deferred<ReaderPosition>();
    const directSave = deferred<ReaderPosition>();
    const saveReaderPosition = vi
      .fn<ReaderSessionBackend["saveReaderPosition"]>()
      .mockImplementationOnce(() => stagedSave.promise)
      .mockImplementationOnce(() => directSave.promise);
    const cache = new ReaderSessionCache(
      backend({
        getReaderPosition: vi.fn(async () => null),
        saveReaderPosition,
      }),
    );
    await cache.load(identity);

    cache.stageHandoff(identity, capturedPosition(400));
    const saving = cache.savePosition(identity, capturedPosition(800));

    expect(saveReaderPosition).toHaveBeenCalledOnce();
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      400,
      "10",
      "Text",
      12,
    );
    stagedSave.resolve(readerPosition(400, 301));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveReaderPosition).toHaveBeenCalledTimes(2);
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      800,
      "10",
      "Text",
      12,
    );
    directSave.resolve(readerPosition(800, 302));
    await saving;
    expect(cache.peek(identity)?.position).toEqual(readerPosition(800, 302));
  });

  it("replaces an in-flight staged handoff with the latest capture", async () => {
    const firstSave = deferred<ReaderPosition>();
    const secondSave = deferred<ReaderPosition>();
    const saveReaderPosition = vi
      .fn<ReaderSessionBackend["saveReaderPosition"]>()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const cache = new ReaderSessionCache(
      backend({
        getReaderPosition: vi.fn(async () => null),
        saveReaderPosition,
      }),
    );
    await cache.load(identity);

    cache.stageHandoff(identity, capturedPosition(400));
    cache.stageHandoff(identity, capturedPosition(800));

    expect(cache.peek(identity)?.position?.scrollTop).toBe(800);
    expect(saveReaderPosition).toHaveBeenCalledOnce();
    firstSave.resolve(readerPosition(400, 301));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveReaderPosition).toHaveBeenCalledTimes(2);
    expect(saveReaderPosition).toHaveBeenLastCalledWith(
      guideKey,
      800,
      "10",
      "Text",
      12,
    );
    secondSave.resolve(readerPosition(800, 302));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.peek(identity)?.position).toEqual(readerPosition(800, 302));
  });

  it("rolls an optimistic position back when persistence fails", async () => {
    const failure = new Error("disk unavailable");
    const cache = new ReaderSessionCache(
      backend({
        saveReaderPosition: vi.fn(async () => {
          throw failure;
        }),
      }),
    );
    const previous = await cache.load(identity);

    await expect(
      cache.savePosition(identity, capturedPosition(888)),
    ).rejects.toBe(failure);

    expect(cache.peek(identity)).toEqual(previous);
  });

  it("rolls back only the position when a concurrent refresh succeeds", async () => {
    const refreshedGuide = deferred<DownloadedGuide>();
    const refreshedPosition = deferred<ReaderPosition | null>();
    const failedSave = deferred<ReaderPosition>();
    const failure = new Error("disk unavailable");
    const getGuide = vi
      .fn<ReaderSessionBackend["getGuide"]>()
      .mockResolvedValueOnce(guide("Old guide"))
      .mockImplementationOnce(() => refreshedGuide.promise);
    const getReaderPosition = vi
      .fn<ReaderSessionBackend["getReaderPosition"]>()
      .mockResolvedValueOnce(readerPosition(100))
      .mockImplementationOnce(() => refreshedPosition.promise);
    const cache = new ReaderSessionCache(
      backend({
        getGuide,
        getReaderPosition,
        saveReaderPosition: vi.fn(() => failedSave.promise),
      }),
    );
    await cache.load(identity);

    const refreshing = cache.load(identity, { forceRefresh: true });
    const saving = cache.savePosition(identity, capturedPosition(777));
    refreshedGuide.resolve(guide("New guide"));
    refreshedPosition.resolve(readerPosition(100));
    const refreshed = await refreshing;
    expect(refreshed.guide.title).toBe("New guide");
    expect(refreshed.position?.scrollTop).toBe(777);

    const rejected = expect(saving).rejects.toBe(failure);
    failedSave.reject(failure);
    await rejected;
    expect(cache.peek(identity)?.guide.title).toBe("New guide");
    expect(cache.peek(identity)?.position?.scrollTop).toBe(100);
  });

  it("loads after clear only after an older in-flight save settles", async () => {
    const releaseSave = deferred<void>();
    let stored = readerPosition(100);
    const getReaderPosition = vi.fn(async () => stored);
    const saveReaderPosition = vi.fn(
      async (_key: string, scrollTop: number) => {
        await releaseSave.promise;
        stored = readerPosition(scrollTop, 301);
        return stored;
      },
    );
    const cache = new ReaderSessionCache(
      backend({ getReaderPosition, saveReaderPosition }),
    );
    await cache.load(identity);

    const saving = cache.savePosition(identity, capturedPosition(777));
    cache.clear();
    const loading = cache.load(identity);

    expect(getReaderPosition).toHaveBeenCalledOnce();
    releaseSave.resolve(undefined);
    await saving;
    const loaded = await loading;
    expect(getReaderPosition).toHaveBeenCalledTimes(2);
    expect(loaded.position?.scrollTop).toBe(777);
    expect(cache.peek(identity)?.position?.scrollTop).toBe(777);
  });

  it("clear removes cached and staged state without late load repopulation", async () => {
    const pendingGuide = deferred<DownloadedGuide>();
    const pendingPosition = deferred<ReaderPosition | null>();
    const saveReaderPosition = vi.fn(async () => readerPosition(400));
    const cache = new ReaderSessionCache(
      backend({
        getGuide: vi.fn(() => pendingGuide.promise),
        getReaderPosition: vi.fn(() => pendingPosition.promise),
        saveReaderPosition,
      }),
    );
    cache.stageHandoff(identity, capturedPosition(400));
    const loading = cache.load(identity);

    cache.clear();
    pendingGuide.resolve(guide("Late guide"));
    pendingPosition.resolve(null);
    await loading;

    expect(cache.peek(identity)).toBeNull();
    expect(saveReaderPosition).not.toHaveBeenCalled();
  });

  it("retains only the two most recently used guide sessions", async () => {
    const first = identity;
    const second = { appId: "1113000", guideId: "3414883878" };
    const third = { appId: "1113000", guideId: "3414883879" };
    const cache = new ReaderSessionCache(backend());

    await cache.load(first);
    await cache.load(second);
    expect(cache.peek(first)).not.toBeNull();
    await cache.load(third);

    expect(cache.peek(first)).not.toBeNull();
    expect(cache.peek(second)).toBeNull();
    expect(cache.peek(third)).not.toBeNull();
  });
});
