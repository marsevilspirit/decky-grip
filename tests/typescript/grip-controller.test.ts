import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GripController,
  LIFECYCLE_POLL_MS,
  SAVE_DEBOUNCE_MS,
  ZERO_SCROLL_CONFIRM_MS,
  type GripBackend,
} from "../../src/grip-controller";
import { RuntimeStatusStore } from "../../src/runtime-status";
import type { GuideIdentity } from "../../src/steam/guide-key";
import type { GuideScroller } from "../../src/steam/guide-scroll";
import type {
  GuideSelection,
  SteamGuideRuntime,
  SteamLocation,
} from "../../src/steam/runtime";

const APP_ID = "1113000";
const GUIDE_ID = "3414883877";
const GUIDE_KEY = `${APP_ID}:${GUIDE_ID}`;

class FakeRuntime implements SteamGuideRuntime {
  readonly identity = {};
  appId = APP_ID;
  location: SteamLocation = {
    pathname: `/app/${APP_ID}/overlay/guides`,
    key: "route-key",
    state: {},
  };
  selectedGuideId: string | null = null;
  scrollTop = 0;
  clientHeight = 400;
  scrollHeight = 2_000;
  imagesComplete = true;
  scrollerVisible = true;
  readonly element: HTMLElement;

  constructor() {
    const runtime = this;
    this.element = {
      isConnected: true,
      get scrollTop() {
        return runtime.scrollTop;
      },
    } as HTMLElement;
  }

  private readonly historyListeners = new Set<() => void>();
  private readonly scrollListeners = new Set<(scrollTop: number) => void>();
  private readonly interactionListeners = new Set<
    (scrollIntent: boolean) => void
  >();
  private readonly layoutListeners = new Set<() => void>();
  private readonly focusListeners = new Set<(focused: boolean) => void>();
  private readonly selectionListeners = new Set<
    (selection: GuideSelection) => void
  >();

  getLocation(): SteamLocation {
    return this.location;
  }

  getActiveGuide(): GuideIdentity | null {
    return this.selectedGuideId &&
      new RegExp(`^/app/${this.appId}/overlay/guides/?$`).test(
        this.location.pathname,
      )
      ? { appId: this.appId, guideId: this.selectedGuideId }
      : null;
  }

  getGuideScroller(): GuideScroller | null {
    if (!this.selectedGuideId || !this.scrollerVisible) {
      return null;
    }
    const runtime = this;
    return {
      element: this.element,
      get imagesComplete() {
        return runtime.imagesComplete;
      },
      get clientHeight() {
        return runtime.clientHeight;
      },
      get scrollHeight() {
        return runtime.scrollHeight;
      },
      get scrollTop() {
        return runtime.scrollTop;
      },
      scrollTo(scrollTop: number) {
        runtime.scrollTop = Math.min(
          scrollTop,
          Math.max(0, runtime.scrollHeight - runtime.clientHeight),
        );
        runtime.emitScroll();
      },
    };
  }

  replaceLocationState(state: Record<string, unknown>): void {
    this.location = { ...this.location, state, key: "replaced-key" };
    this.emitHistory();
  }

  listenHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  listenGuideScroll(listener: (scrollTop: number) => void): () => void {
    this.scrollListeners.add(listener);
    return () => this.scrollListeners.delete(listener);
  }

  listenGuideInteraction(
    listener: (scrollIntent: boolean) => void,
  ): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  listenGuideLayout(listener: () => void): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  listenWindowFocus(listener: (focused: boolean) => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }

  beforeGuideSelection(
    listener: (selection: GuideSelection) => void,
  ): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  selectGuide(guideId: string | null): void {
    const selection = { appId: this.appId, guideId };
    for (const listener of this.selectionListeners) {
      listener(selection);
    }
    this.selectedGuideId = guideId;
  }

  switchApp(appId: string): void {
    this.selectedGuideId = null;
    this.appId = appId;
    this.location = {
      pathname: `/app/${appId}/overlay/guides`,
      key: `route-${appId}`,
      state: {},
    };
    this.emitHistory();
  }

  emitHistory(): void {
    for (const listener of this.historyListeners) {
      listener();
    }
  }

  emitScroll(): void {
    for (const listener of this.scrollListeners) {
      listener(this.scrollTop);
    }
  }

  emitInteraction(scrollIntent = true): void {
    for (const listener of this.interactionListeners) {
      listener(scrollIntent);
    }
  }

  emitLayout(): void {
    for (const listener of this.layoutListeners) {
      listener();
    }
  }

  emitFocus(focused: boolean): void {
    for (const listener of this.focusListeners) {
      listener(focused);
    }
  }

  listenerCount(): number {
    return (
      this.historyListeners.size +
      this.scrollListeners.size +
      this.interactionListeners.size +
      this.layoutListeners.size +
      this.focusListeners.size +
      this.selectionListeners.size
    );
  }
}

function makeHarness(
  positions: Awaited<ReturnType<GripBackend["getPositions"]>>,
) {
  const runtime = new FakeRuntime();
  const backend: GripBackend = {
    getPositions: vi.fn().mockResolvedValue(positions),
    savePosition: vi.fn().mockResolvedValue({}),
  };
  const status = new RuntimeStatusStore();
  const controller = new GripController({
    backend,
    runtimeFactory: () => runtime,
    status,
  });
  return { backend, controller, runtime, status };
}

describe("GRIP controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores passive pointer movement while waiting to restore", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
    });
    await harness.controller.start();

    harness.runtime.scrollHeight = 900;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.runtime.scrollTop).toBe(0);
    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.runtime.emitInteraction(false);

    harness.runtime.scrollHeight = 2_000;
    harness.runtime.emitLayout();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.scrollTop).toBe(1_200);
    expect(harness.runtime.location.state).toMatchObject({
      [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 1_200,
    });
    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    expect(harness.status.getSnapshot().lastRestored).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
      scrollTop: 1_200,
    });

    harness.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains each app's runtime guide while switching games", async () => {
    const secondAppId = "222";
    const secondGuideId = "2002";
    const harness = makeHarness({});
    await harness.controller.start();

    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(0);
    harness.runtime.switchApp(secondAppId);
    harness.runtime.selectGuide(secondGuideId);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.status.getRecentGuide(APP_ID)).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
    });
    expect(harness.status.getRecentGuide(secondAppId)).toEqual({
      appId: secondAppId,
      guideId: secondGuideId,
    });

    harness.runtime.switchApp(APP_ID);
    expect(harness.status.getSnapshot().activeGuide).toBeNull();
    expect(harness.status.getRecentGuide(APP_ID)).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
    });
    harness.controller.stop();
  });

  it("keeps watching when positions fail and can retry them later", async () => {
    const failure = new Error("positions.json is malformed");
    const harness = makeHarness({});
    vi.mocked(harness.backend.getPositions)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
      });

    await expect(harness.controller.start()).resolves.toBeUndefined();
    expect(harness.runtime.listenerCount()).toBeGreaterThan(0);
    expect(harness.status.getSnapshot()).toMatchObject({
      phase: "watching",
      positionWarning:
        "阅读位置加载失败，GRIP 已继续运行：positions.json is malformed",
      savedCount: 0,
    });

    await expect(harness.controller.retryPositions()).resolves.toBe(true);
    expect(harness.backend.getPositions).toHaveBeenCalledTimes(2);
    expect(harness.status.getSnapshot()).toMatchObject({
      positionWarning: null,
      savedCount: 1,
    });
    expect(harness.status.getRecentGuide(APP_ID)).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
    });
    harness.controller.stop();
  });

  it("preserves the newer in-memory bookmark during an ordinary retry", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    harness.runtime.emitInteraction();
    harness.runtime.scrollTop = 1_500;
    harness.runtime.emitScroll();
    vi.mocked(harness.backend.getPositions).mockResolvedValueOnce({
      [GUIDE_KEY]: { scrollTop: 100, updatedAt: 1_000_500 },
    });

    await expect(harness.controller.retryPositions()).resolves.toBe(true);
    harness.runtime.selectGuide(null);
    await vi.advanceTimersByTimeAsync(0);
    harness.runtime.scrollTop = 0;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.scrollTop).toBe(1_500);
    harness.controller.stop();
  });

  it("drops old in-memory bookmarks when reloading after repair", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
    });
    await harness.controller.start();
    vi.mocked(harness.backend.getPositions).mockResolvedValueOnce({});

    await expect(harness.controller.reloadPositionsAfterRepair()).resolves.toBe(
      true,
    );
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.scrollTop).toBe(0);
    expect(harness.status.getSnapshot().savedCount).toBe(0);
    harness.controller.stop();
  });

  it("ignores an old in-flight save after a repair reset", async () => {
    let finishSave!: () => void;
    const savePosition = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const runtime = new FakeRuntime();
    const backend: GripBackend = {
      getPositions: vi.fn().mockResolvedValue({}),
      savePosition,
    };
    const status = new RuntimeStatusStore();
    const controller = new GripController({
      backend,
      runtimeFactory: () => runtime,
      status,
    });
    await controller.start();
    runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(0);
    runtime.emitInteraction();
    runtime.scrollTop = 333;
    runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(savePosition).toHaveBeenCalledTimes(1);

    await expect(controller.reloadPositionsAfterRepair()).resolves.toBe(true);
    runtime.selectedGuideId = null;
    finishSave();
    await vi.advanceTimersByTimeAsync(0);

    expect(status.getSnapshot()).toMatchObject({
      savedCount: 0,
      lastCaptured: null,
      lastRestored: null,
    });
    controller.stop();
  });

  it("does not persist Steam's temporary clamped value during restoration", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_500, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollHeight = 700;
    harness.runtime.selectGuide(GUIDE_ID);

    harness.runtime.scrollTop = 300;
    harness.runtime.emitScroll();
    harness.runtime.location = {
      ...harness.runtime.location,
      state: {
        [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 300,
      },
    };
    harness.runtime.emitHistory();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });

  it("cancels a pending restore when the user interacts, then saves scrolling", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_500, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollHeight = 700;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(0);
    harness.runtime.emitInteraction();

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
    expect(harness.backend.savePosition).not.toHaveBeenCalled();

    harness.runtime.scrollTop = 222;
    harness.runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);

    expect(harness.backend.savePosition).toHaveBeenCalledWith(GUIDE_KEY, 222);
    harness.controller.stop();
  });

  it("serializes a return to the persisted value behind an in-flight save", async () => {
    const runtime = new FakeRuntime();
    const completions: Array<() => void> = [];
    const savePosition = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve);
        }),
    );
    const backend: GripBackend = {
      getPositions: vi.fn().mockResolvedValue({
        [GUIDE_KEY]: { scrollTop: 0, updatedAt: 900_000 },
      }),
      savePosition,
    };
    const controller = new GripController({
      backend,
      runtimeFactory: () => runtime,
      status: new RuntimeStatusStore(),
    });
    await controller.start();
    runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(0);
    runtime.emitInteraction();

    runtime.scrollTop = 100;
    runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(savePosition).toHaveBeenCalledTimes(1);
    expect(savePosition).toHaveBeenLastCalledWith(GUIDE_KEY, 100);

    runtime.scrollTop = 0;
    runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );
    expect(savePosition).toHaveBeenCalledTimes(1);

    completions.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(savePosition).toHaveBeenCalledTimes(2);
    expect(savePosition).toHaveBeenLastCalledWith(GUIDE_KEY, 0);

    completions.shift()?.();
    await Promise.resolve();
    controller.stop();
  });

  it("cancels an old restore before a different guide reuses the panel", async () => {
    const secondGuideId = "3414883999";
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);

    await vi.advanceTimersByTimeAsync(250);
    harness.runtime.selectGuide(secondGuideId);
    harness.runtime.scrollTop = 40;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.scrollTop).toBe(40);
    expect(harness.runtime.location.state).not.toHaveProperty(
      `OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`,
    );
    harness.controller.stop();
  });

  it("cleans earlier listeners if a later runtime attachment step fails", async () => {
    const harness = makeHarness({});
    harness.runtime.listenGuideLayout = () => {
      throw new Error("observer unavailable");
    };

    await harness.controller.start();

    expect(harness.runtime.listenerCount()).toBe(0);
    expect(harness.status.getSnapshot().phase).toBe("error");
    harness.controller.stop();
  });

  it("leaves no hidden restore timer after synchronous history replacement", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 1_200, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);

    await vi.advanceTimersByTimeAsync(701);
    harness.controller.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes the current DOM position before Steam closes the guide", async () => {
    const harness = makeHarness({});
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(0);
    harness.runtime.emitInteraction();

    harness.runtime.scrollTop = 5561.3335;
    harness.runtime.emitScroll();
    harness.runtime.selectGuide(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.backend.savePosition).toHaveBeenCalledWith(
      GUIDE_KEY,
      5561.3335,
    );
    harness.controller.stop();
  });

  it("polls the live scroller when a gamepad scroll event is missed", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 6_788, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 12_000;
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_500);

    harness.runtime.scrollTop = 3_956;
    await vi.advanceTimersByTimeAsync(LIFECYCLE_POLL_MS + SAVE_DEBOUNCE_MS);

    expect(harness.backend.savePosition).toHaveBeenCalledWith(GUIDE_KEY, 3_956);
    harness.controller.stop();
  });

  it("captures the old guide DOM before Steam-key navigation clears its route", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 6_788, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 12_000;
    await harness.controller.start();
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_500);

    harness.runtime.scrollTop = 3_956;
    harness.runtime.location = {
      pathname: "/apprunning",
      state: {},
    };
    harness.runtime.emitHistory();
    harness.runtime.emitFocus(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.backend.savePosition).toHaveBeenCalledTimes(1);
    expect(harness.backend.savePosition).toHaveBeenCalledWith(GUIDE_KEY, 3_956);
    expect(harness.status.getSnapshot().lastGuide).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
    });
    harness.controller.stop();
  });

  it("restores GRIP's bookmark instead of importing stale Steam state on reopen", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 3_956, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 12_000;
    harness.runtime.location = { pathname: "/apprunning", state: {} };
    harness.runtime.selectedGuideId = GUIDE_ID;
    await harness.controller.start();

    harness.runtime.location = {
      pathname: `/app/${APP_ID}/overlay/guides`,
      state: {
        [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 2_100,
      },
    };
    harness.runtime.emitHistory();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.scrollTop).toBe(3_956);
    expect(harness.runtime.location.state).toMatchObject({
      [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 3_956,
    });
    expect(harness.backend.savePosition).not.toHaveBeenCalledWith(
      GUIDE_KEY,
      2_100,
    );
    harness.controller.stop();
  });

  it("blocks Steam's stale entry scroll even when it fires before History", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 4_040, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 12_000;
    harness.runtime.location = { pathname: "/apprunning", state: {} };
    harness.runtime.selectedGuideId = GUIDE_ID;
    await harness.controller.start();

    harness.runtime.location = {
      pathname: `/app/${APP_ID}/overlay/guides`,
      state: {
        [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 2_100,
      },
    };
    harness.runtime.scrollTop = 2_100;
    harness.runtime.emitScroll();
    expect(harness.status.getSnapshot().lastCaptured).toBeNull();
    harness.runtime.emitHistory();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(harness.runtime.scrollTop).toBe(4_040);
    expect(harness.runtime.location.state).toMatchObject({
      [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 4_040,
    });
    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    expect(harness.status.getSnapshot().lastRestored).toEqual({
      appId: APP_ID,
      guideId: GUIDE_ID,
      scrollTop: 4_040,
    });
    harness.controller.stop();
  });

  it("ignores Steam's teardown zero without user scroll intent", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 8_000;
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    harness.runtime.location = {
      ...harness.runtime.location,
      state: {
        [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 0,
      },
    };
    harness.runtime.emitHistory();
    harness.runtime.location = {
      pathname: `/library/app/${APP_ID}`,
      state: {},
    };
    harness.runtime.emitHistory();
    harness.runtime.selectedGuideId = null;
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    expect(harness.status.getSnapshot().lastCaptured).toBeNull();
    harness.controller.stop();
  });

  it("does not treat an ordinary pointer press as permission to save teardown zero", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(false);
    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });

  it("does not let History state alone replace a nonzero bookmark with zero", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(true);
    harness.runtime.location = {
      ...harness.runtime.location,
      state: {
        [`OverlayGuide_${GUIDE_ID}ScrollTop_HistoryValue`]: 0,
      },
    };
    harness.runtime.emitHistory();
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });

  it("persists an intentional scroll to the top after it remains stable", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(true);
    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).toHaveBeenCalledWith(GUIDE_KEY, 0);
    harness.controller.stop();
  });

  it("keeps the old bookmark when an intentional zero is followed by exit", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(true);
    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    harness.runtime.selectedGuideId = null;
    harness.runtime.location = {
      pathname: `/library/app/${APP_ID}`,
      state: {},
    };
    harness.runtime.emitHistory();
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });

  it("does not carry zero authorization into a quick reopen of the same guide", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    harness.runtime.scrollHeight = 8_000;
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(true);
    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    harness.runtime.selectGuide(null);
    await vi.advanceTimersByTimeAsync(0);

    harness.runtime.location = {
      pathname: `/app/${APP_ID}/overlay/guides`,
      state: {},
    };
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    expect(harness.runtime.scrollTop).toBe(5_432);
    harness.controller.stop();
  });

  it("clears a provisional zero when the Steam window loses focus", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: 5_432, updatedAt: 900_000 },
    });
    await harness.controller.start();
    harness.runtime.scrollTop = 5_432;
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    harness.runtime.emitInteraction(true);
    harness.runtime.scrollTop = 0;
    harness.runtime.emitScroll();
    harness.runtime.emitFocus(false);
    await vi.advanceTimersByTimeAsync(
      ZERO_SCROLL_CONFIRM_MS + SAVE_DEBOUNCE_MS,
    );

    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });

  it("ignores an invalid snapshot but still attaches the runtime", async () => {
    const harness = makeHarness({
      [GUIDE_KEY]: { scrollTop: Number.NaN, updatedAt: 1 },
    });
    await harness.controller.start();

    expect(harness.status.getSnapshot()).toMatchObject({
      phase: "watching",
      savedCount: 0,
    });
    expect(harness.status.getSnapshot().positionWarning).toContain(
      "阅读位置加载失败，GRIP 已继续运行",
    );
    expect(harness.runtime.listenerCount()).toBeGreaterThan(0);
    harness.runtime.selectGuide(GUIDE_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.backend.savePosition).not.toHaveBeenCalled();
    harness.controller.stop();
  });
});
