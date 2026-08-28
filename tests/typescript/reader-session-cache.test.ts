import { describe, expect, it, vi } from "vitest";

import type { CapturedReaderPosition } from "../../src/reader/anchor";
import {
  ReaderSessionCache,
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
    getGuide: vi.fn(async () => guide("Cached guide")),
    getReaderPosition: vi.fn(async () => readerPosition(120)),
    saveReaderPosition: vi.fn(async (_key, scrollTop) =>
      readerPosition(scrollTop, 300),
    ),
  };
  return { ...defaults, ...overrides };
}

describe("ReaderSessionCache", () => {
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
    });
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

    expect(cache.peek(identity)).toBe(previous);
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
