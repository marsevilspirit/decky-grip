import type { PositionSnapshots } from "./backend";
import {
  makeGuideKey,
  splitGuideKey,
  type GuideIdentity,
} from "./steam/guide-key";
import {
  MAX_SCROLL_TOP,
  mergeGuideScrollSnapshot,
  readGuideScrollSnapshot,
} from "./steam/location-state";
import type { GuideSelection, SteamGuideRuntime } from "./steam/runtime";
import type { GuideScroller } from "./steam/guide-scroll";
import { captureNativeReaderHandoff } from "./steam/reader-handoff";
import type { CapturedReaderPosition } from "./reader/anchor";
import { RuntimeStatusStore } from "./runtime-status";

export const SAVE_DEBOUNCE_MS = 600;
export const LIFECYCLE_POLL_MS = 350;
export const RUNTIME_POLL_MS = 1_000;
export const RESTORE_CHECK_MS = 100;
export const RESTORE_IMAGE_GRACE_MS = 3_000;
export const RESTORE_TIMEOUT_MS = 15_000;
export const SELECTION_HANDOFF_MS = 350;
export const ZERO_SCROLL_CONFIRM_MS = 400;

const RESTORE_CONFIRM_MS = 400;
const SAVE_RETRY_MS = 2_000;
const MAX_SAVE_RETRIES = 3;
const RESTORE_EPSILON = 1;
const SCROLL_INTENT_WINDOW_MS = 2_000;
const RECENT_SCROLL_WINDOW_MS = 1_000;
const HEIGHT_EPSILON = 1;
const REQUIRED_STABLE_HEIGHT_CHECKS = 2;

export interface GripBackend {
  getPositions(): Promise<PositionSnapshots>;
  savePosition(guideKey: string, scrollTop: number): Promise<unknown>;
}

export interface GripControllerOptions {
  backend: GripBackend;
  runtimeFactory: () => SteamGuideRuntime | null;
  status: RuntimeStatusStore;
}

interface CachedPosition {
  scrollTop: number;
  updatedAt: number;
}

interface RestoreEpoch {
  generation: number;
  identity: GuideIdentity;
  guideKey: string;
  target: number;
  startedAt: number;
  readyAfter: number;
  previousHeight: number | null;
  stableHeightChecks: number;
  timer: ReturnType<typeof setTimeout> | null;
  applying: boolean;
}

interface QueuedSave {
  guideKey: string;
  scrollTop: number;
}

interface PendingZeroCapture {
  identity: GuideIdentity;
  guideKey: string;
  scrollerElement: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
}

interface RecentGuideActivity {
  guideKey: string;
  at: number;
}

function isScrollTop(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SCROLL_TOP
  );
}

function sameGuide(
  left: GuideIdentity | null,
  right: GuideIdentity | null,
): boolean {
  return left?.appId === right?.appId && left?.guideId === right?.guideId;
}

function readPositionSnapshots(
  value: PositionSnapshots,
): Map<string, CachedPosition> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Backend returned an invalid position snapshot");
  }

  const positions = new Map<string, CachedPosition>();
  for (const [guideKey, rawPosition] of Object.entries(value)) {
    splitGuideKey(guideKey);
    if (
      !rawPosition ||
      !isScrollTop(rawPosition.scrollTop) ||
      !Number.isSafeInteger(rawPosition.updatedAt) ||
      rawPosition.updatedAt < 0
    ) {
      throw new TypeError("Backend returned an invalid saved position");
    }
    positions.set(guideKey, { ...rawPosition });
  }
  return positions;
}

export class GripController {
  private readonly backend: GripBackend;
  private readonly runtimeFactory: () => SteamGuideRuntime | null;
  private readonly status: RuntimeStatusStore;

  private positions = new Map<string, CachedPosition>();
  private readonly persistedKeys = new Set<string>();
  private readonly pendingScrollTops = new Map<string, number>();
  private readonly saveRetries = new Map<string, number>();
  private readonly failedSaves = new Set<string>();
  private readonly saveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly saveQueue: QueuedSave[] = [];
  private saveInFlight = false;

  private runtime: SteamGuideRuntime | null = null;
  private runtimeCleanups: Array<() => void> = [];
  private runtimeMonitor: ReturnType<typeof setInterval> | null = null;
  private lifecycleMonitor: ReturnType<typeof setInterval> | null = null;
  private activeGuide: GuideIdentity | null = null;
  private lastScrollerElement: HTMLElement | null = null;
  private restore: RestoreEpoch | null = null;
  private restoreGeneration = 0;
  private selectionGeneration = 0;
  private captureGuardKey: string | null = null;
  private captureGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingZeroCapture: PendingZeroCapture | null = null;
  private lastScrollIntent: RecentGuideActivity | null = null;
  private lastNonzeroScroll: RecentGuideActivity | null = null;
  private started = false;
  private disposed = false;

  constructor(options: GripControllerOptions) {
    this.backend = options.backend;
    this.runtimeFactory = options.runtimeFactory;
    this.status = options.status;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      this.positions = readPositionSnapshots(await this.backend.getPositions());
      for (const guideKey of this.positions.keys()) {
        this.persistedKeys.add(guideKey);
      }
    } catch (error: unknown) {
      this.reportError("Could not load saved guide positions", error);
      return;
    }

    if (this.disposed) {
      return;
    }

    this.status.update({ savedCount: this.persistedKeys.size });
    this.refreshRuntime();
    this.runtimeMonitor = setInterval(
      () => this.refreshRuntime(),
      RUNTIME_POLL_MS,
    );
  }

  captureReaderHandoff(identity: GuideIdentity): CapturedReaderPosition | null {
    const runtime = this.runtime;
    if (!runtime || !sameGuide(this.readActiveGuide(), identity)) {
      return null;
    }
    const scroller = runtime.getGuideScroller();
    if (!scroller) {
      return null;
    }
    const saved = this.positions.get(makeGuideKey(identity));
    return captureNativeReaderHandoff(
      scroller.element,
      saved?.scrollTop ?? scroller.scrollTop,
    );
  }

  stop(): void {
    if (this.disposed) {
      return;
    }

    this.captureCurrentPosition();
    this.flushAll();
    this.disposed = true;
    this.selectionGeneration += 1;
    this.clearCaptureGuard();
    this.clearPendingZeroCapture();
    this.clearGuideActivity();
    this.cancelRestore();
    this.detachRuntime();

    if (this.runtimeMonitor !== null) {
      clearInterval(this.runtimeMonitor);
      this.runtimeMonitor = null;
    }
  }

  private refreshRuntime(): void {
    if (this.disposed) {
      return;
    }

    let nextRuntime: SteamGuideRuntime | null;
    try {
      nextRuntime = this.runtimeFactory();
    } catch (error: unknown) {
      this.reportError("Could not inspect Steam's guide reader", error);
      return;
    }

    if (nextRuntime?.identity === this.runtime?.identity) {
      return;
    }

    this.captureCurrentPosition();
    this.flushAll();
    this.detachRuntime();
    if (nextRuntime) {
      this.attachRuntime(nextRuntime);
    } else {
      this.status.update({
        phase: "starting",
        message: "Waiting for Steam's guide reader…",
        activeGuide: null,
      });
    }
  }

  private attachRuntime(runtime: SteamGuideRuntime): void {
    this.runtime = runtime;
    this.runtimeCleanups = [];
    try {
      this.runtimeCleanups.push(
        runtime.listenHistory(() => this.handleHistoryChange()),
      );
      this.runtimeCleanups.push(
        runtime.listenGuideScroll((scrollTop) =>
          this.handleGuideScroll(scrollTop),
        ),
      );
      this.runtimeCleanups.push(
        runtime.listenGuideInteraction((scrollIntent) =>
          this.handleGuideInteraction(scrollIntent),
        ),
      );
      this.runtimeCleanups.push(
        runtime.listenGuideLayout(() => this.handleGuideLayout()),
      );
      this.runtimeCleanups.push(
        runtime.listenWindowFocus((focused) => this.handleWindowFocus(focused)),
      );
      this.runtimeCleanups.push(
        runtime.beforeGuideSelection((selection) =>
          this.handleGuideSelection(selection),
        ),
      );
      this.lifecycleMonitor = setInterval(
        () => this.handleLifecycle(),
        LIFECYCLE_POLL_MS,
      );
      this.status.update({
        phase: "watching",
        message: "Watching Steam guides",
      });
      this.handleLifecycle();
    } catch (error: unknown) {
      this.reportError("Could not attach to Steam's guide reader", error);
      this.detachRuntime();
    }
  }

  private detachRuntime(): void {
    this.selectionGeneration += 1;
    this.clearCaptureGuard();
    this.clearPendingZeroCapture();
    this.clearGuideActivity();
    this.cancelRestore();
    if (this.lifecycleMonitor !== null) {
      clearInterval(this.lifecycleMonitor);
      this.lifecycleMonitor = null;
    }
    for (const cleanup of this.runtimeCleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.warn("[GRIP] Runtime cleanup failed", error);
      }
    }
    this.runtimeCleanups = [];
    this.runtime = null;
    this.activeGuide = null;
    this.lastScrollerElement = null;
  }

  private handleGuideSelection(selection: GuideSelection): void {
    const selectionGeneration = ++this.selectionGeneration;
    this.captureCurrentPosition();
    this.flushActiveGuide();
    this.cancelRestore();
    this.clearCaptureGuard();
    this.clearPendingZeroCapture();
    this.clearGuideActivity();

    if (selection.guideId === null) {
      queueMicrotask(() =>
        this.finishGuideSelection(selection, selectionGeneration),
      );
      return;
    }

    this.armCaptureGuard(
      makeGuideKey({
        appId: selection.appId,
        guideId: selection.guideId,
      }),
    );
    queueMicrotask(() =>
      this.finishGuideSelection(selection, selectionGeneration),
    );
  }

  private finishGuideSelection(
    selection: GuideSelection,
    selectionGeneration: number,
  ): void {
    if (
      this.disposed ||
      selectionGeneration !== this.selectionGeneration ||
      !this.runtime
    ) {
      return;
    }

    const activeGuide = this.readActiveGuide();
    if (selection.guideId === null) {
      this.setActiveGuide(activeGuide);
      this.handleLifecycle();
      return;
    }

    const identity = {
      appId: selection.appId,
      guideId: selection.guideId,
    };
    if (!sameGuide(activeGuide, identity)) {
      this.clearCaptureGuard();
      this.setActiveGuide(activeGuide);
      return;
    }

    this.setActiveGuide(identity);
    const position = this.positions.get(makeGuideKey(identity));
    if (position) {
      this.beginRestore(identity, position.scrollTop, SELECTION_HANDOFF_MS);
    } else {
      this.lastScrollerElement =
        this.runtime.getGuideScroller()?.element ?? null;
    }
  }

  private handleHistoryChange(): void {
    const previousGuide = this.activeGuide;
    const previousScrollerElement = this.lastScrollerElement;
    const activeGuide = this.readActiveGuide();
    const guideChanged = !sameGuide(previousGuide, activeGuide);
    const enteringGuardedGuide =
      activeGuide !== null &&
      this.captureGuardKey === makeGuideKey(activeGuide);
    if (previousGuide && guideChanged && !enteringGuardedGuide) {
      this.captureKnownScrollerPosition(previousGuide, previousScrollerElement);
    }
    this.setActiveGuide(activeGuide);
    if (!activeGuide || !this.runtime) {
      this.flushAll();
      return;
    }

    const guideKey = makeGuideKey(activeGuide);
    if (this.captureGuardKey === guideKey) {
      return;
    }
    if (this.restore?.guideKey === guideKey) {
      if (!this.restore.applying) {
        this.scheduleRestoreCheck();
      }
      return;
    }

    const position = this.positions.get(guideKey);
    if (guideChanged && position) {
      this.beginRestore(activeGuide, position.scrollTop, SELECTION_HANDOFF_MS);
      return;
    }

    if (position) {
      this.handleLifecycle();
      return;
    }

    const snapshot = readGuideScrollSnapshot(
      this.runtime.getLocation().state,
      activeGuide.guideId,
    );
    if (snapshot) {
      this.recordPosition(activeGuide, snapshot.scrollTop);
    }
  }

  private handleGuideScroll(scrollTop: number): void {
    const activeGuide = this.readActiveGuide();
    if (!activeGuide || !isScrollTop(scrollTop)) {
      return;
    }
    if (!sameGuide(this.activeGuide, activeGuide)) {
      // Steam can apply its own History scroll value before notifying our
      // History listener. Reconcile the route first so an existing GRIP
      // bookmark starts a restore epoch before this stale scroll is observed.
      this.handleHistoryChange();
      return;
    }
    const guideKey = makeGuideKey(activeGuide);
    if (this.captureGuardKey === guideKey) {
      return;
    }
    if (this.restore?.guideKey === guideKey) {
      return;
    }
    if (scrollTop > RESTORE_EPSILON) {
      this.lastNonzeroScroll = { guideKey, at: Date.now() };
    }
    this.recordPosition(activeGuide, scrollTop, true);
  }

  private handleGuideInteraction(scrollIntent: boolean): void {
    const activeGuide = this.readActiveGuide();
    if (scrollIntent && activeGuide) {
      this.lastScrollIntent = {
        guideKey: makeGuideKey(activeGuide),
        at: Date.now(),
      };
    }

    if (!this.restore) {
      if (activeGuide && this.captureGuardKey === makeGuideKey(activeGuide)) {
        const currentScroller = this.runtime?.getGuideScroller() ?? null;
        this.clearCaptureGuard();
        this.lastScrollerElement = currentScroller?.element ?? null;
      }
      return;
    }
    const identity = this.restore.identity;
    const currentScroller = this.runtime?.getGuideScroller() ?? null;
    this.clearCaptureGuard();
    this.cancelRestore();
    this.lastScrollerElement = currentScroller?.element ?? null;
    this.status.update({
      phase: "watching",
      activeGuide: identity,
      message: "Restore canceled because you started navigating the guide",
    });
  }

  private handleGuideLayout(): void {
    if (this.restore) {
      this.scheduleRestoreCheck();
    }
    this.handleLifecycle();
  }

  private handleWindowFocus(focused: boolean): void {
    if (!focused) {
      this.captureCurrentPosition();
      this.flushActiveGuide();
      this.clearPendingZeroCapture();
      this.clearGuideActivity();
      return;
    }

    this.lastScrollerElement = null;
    this.handleLifecycle();
  }

  private handleLifecycle(): void {
    const runtime = this.runtime;
    if (!runtime || this.disposed) {
      return;
    }

    const activeGuide = runtime.getActiveGuide();
    const guideChanged = !sameGuide(this.activeGuide, activeGuide);
    this.setActiveGuide(activeGuide);
    if (!activeGuide) {
      this.lastScrollerElement = null;
      return;
    }

    const guideKey = makeGuideKey(activeGuide);
    if (this.captureGuardKey === guideKey) {
      return;
    }
    if (this.restore?.guideKey === guideKey) {
      this.scheduleRestoreCheck();
      return;
    }

    const scroller = runtime.getGuideScroller();
    if (!scroller) {
      this.lastScrollerElement = null;
      return;
    }

    if (scroller.element !== this.lastScrollerElement) {
      this.lastScrollerElement = scroller.element;
      const position = this.positions.get(guideKey);
      if (position) {
        this.beginRestore(
          activeGuide,
          position.scrollTop,
          guideChanged ? SELECTION_HANDOFF_MS : 0,
        );
      } else {
        this.captureLocationState(activeGuide);
      }
      return;
    }

    this.recordPosition(activeGuide, scroller.scrollTop);
  }

  private readActiveGuide(): GuideIdentity | null {
    try {
      return this.runtime?.getActiveGuide() ?? null;
    } catch (error: unknown) {
      this.reportError("Could not read the active Steam guide", error);
      return null;
    }
  }

  private setActiveGuide(identity: GuideIdentity | null): void {
    if (sameGuide(this.activeGuide, identity)) {
      return;
    }

    const previous = this.activeGuide;
    if (this.restore && !sameGuide(this.restore.identity, identity)) {
      this.cancelRestore();
    }
    this.activeGuide = identity;
    this.lastScrollerElement = null;
    this.clearPendingZeroCapture();
    this.clearGuideActivity();
    if (previous) {
      this.flushKey(makeGuideKey(previous));
    }
    this.status.update({
      activeGuide: identity,
      ...(identity ? { lastGuide: identity } : {}),
    });
  }

  private beginRestore(
    identity: GuideIdentity,
    target: number,
    minimumDelay = 0,
  ): void {
    if (!isScrollTop(target)) {
      return;
    }

    this.cancelRestore();
    this.lastScrollerElement = null;
    this.restore = {
      generation: ++this.restoreGeneration,
      identity,
      guideKey: makeGuideKey(identity),
      target,
      startedAt: Date.now(),
      readyAfter: Date.now() + minimumDelay,
      previousHeight: null,
      stableHeightChecks: 0,
      timer: null,
      applying: false,
    };
    this.status.update({
      phase: "watching",
      activeGuide: identity,
      message: `Waiting for guide layout before restoring ${Math.round(target)} px…`,
    });
    this.scheduleRestoreCheck(0);
  }

  private scheduleRestoreCheck(delay = RESTORE_CHECK_MS): void {
    const restore = this.restore;
    if (!restore || restore.timer !== null) {
      return;
    }
    restore.timer = setTimeout(() => {
      if (this.restore?.generation !== restore.generation) {
        return;
      }
      restore.timer = null;
      this.checkRestore(restore);
    }, delay);
  }

  private checkRestore(restore: RestoreEpoch): void {
    const runtime = this.runtime;
    if (!runtime || this.restore?.generation !== restore.generation) {
      return;
    }

    const elapsed = Date.now() - restore.startedAt;
    const activeGuide = runtime.getActiveGuide();
    if (!sameGuide(activeGuide, restore.identity)) {
      if (elapsed < 500) {
        this.scheduleRestoreCheck();
      } else {
        this.cancelRestore();
      }
      return;
    }

    if (Date.now() < restore.readyAfter) {
      this.scheduleRestoreCheck();
      return;
    }

    const scroller = runtime.getGuideScroller();
    if (!scroller) {
      this.retryOrFailRestore(restore, elapsed, "guide panel did not appear");
      return;
    }
    this.lastScrollerElement = scroller.element;

    const currentHeight = scroller.scrollHeight;
    if (
      restore.previousHeight !== null &&
      Math.abs(currentHeight - restore.previousHeight) <= HEIGHT_EPSILON
    ) {
      restore.stableHeightChecks += 1;
    } else {
      restore.stableHeightChecks = 0;
    }
    restore.previousHeight = currentHeight;

    const maxScrollTop = Math.max(0, currentHeight - scroller.clientHeight);
    const canReachTarget = maxScrollTop + RESTORE_EPSILON >= restore.target;
    const layoutStable =
      restore.stableHeightChecks >= REQUIRED_STABLE_HEIGHT_CHECKS;
    const imagesReady =
      scroller.imagesComplete || elapsed >= RESTORE_IMAGE_GRACE_MS;

    if (canReachTarget && layoutStable && imagesReady && !restore.applying) {
      this.applyRestore(restore, scroller);
      return;
    }

    this.retryOrFailRestore(
      restore,
      elapsed,
      canReachTarget
        ? "guide images did not settle"
        : "guide content is shorter than the saved position",
    );
  }

  private applyRestore(restore: RestoreEpoch, scroller: GuideScroller): void {
    restore.applying = true;
    const expectedElement = scroller.element;
    scroller.scrollTo(restore.target);
    restore.timer = setTimeout(() => {
      if (this.restore?.generation !== restore.generation || !this.runtime) {
        return;
      }
      restore.timer = null;
      if (!sameGuide(this.runtime.getActiveGuide(), restore.identity)) {
        this.cancelRestore();
        return;
      }
      const currentScroller = this.runtime.getGuideScroller();
      if (
        !currentScroller ||
        currentScroller.element !== expectedElement ||
        Math.abs(currentScroller.scrollTop - restore.target) > RESTORE_EPSILON
      ) {
        restore.applying = false;
        restore.stableHeightChecks = 0;
        this.retryOrFailRestore(
          restore,
          Date.now() - restore.startedAt,
          "Steam clamped the restored position",
        );
        return;
      }

      try {
        const merged = mergeGuideScrollSnapshot(
          this.runtime.getLocation().state,
          { guideId: restore.identity.guideId, scrollTop: restore.target },
        );
        if (merged.changed) {
          this.runtime.replaceLocationState(merged.state);
        }
      } catch (error: unknown) {
        this.reportError("Could not update Steam's guide history", error);
        this.cancelRestore();
        return;
      }

      restore.timer = setTimeout(
        () => this.confirmRestore(restore),
        RESTORE_CONFIRM_MS,
      );
    }, RESTORE_CHECK_MS);
  }

  private confirmRestore(restore: RestoreEpoch): void {
    if (this.restore?.generation !== restore.generation || !this.runtime) {
      return;
    }
    restore.timer = null;

    const activeGuide = this.runtime.getActiveGuide();
    const scroller = this.runtime.getGuideScroller();
    if (
      sameGuide(activeGuide, restore.identity) &&
      scroller &&
      scroller.element === this.lastScrollerElement &&
      Math.abs(scroller.scrollTop - restore.target) <= RESTORE_EPSILON
    ) {
      this.restore = null;
      this.lastScrollerElement = scroller.element;
      this.status.update({
        phase: "watching",
        activeGuide: restore.identity,
        lastRestored: { ...restore.identity, scrollTop: restore.target },
        message: `Restored guide to ${Math.round(restore.target)} px`,
      });
      return;
    }

    restore.applying = false;
    restore.stableHeightChecks = 0;
    this.retryOrFailRestore(
      restore,
      Date.now() - restore.startedAt,
      "Steam moved the guide after restoration",
    );
  }

  private retryOrFailRestore(
    restore: RestoreEpoch,
    elapsed: number,
    reason: string,
  ): void {
    if (elapsed < RESTORE_TIMEOUT_MS) {
      this.scheduleRestoreCheck();
      return;
    }

    this.restore = null;
    this.status.update({
      phase: "watching",
      activeGuide: restore.identity,
      message: `Kept the saved position; restore timed out because ${reason}`,
    });
  }

  private cancelRestore(): void {
    const restore = this.restore;
    this.restoreGeneration += 1;
    if (restore?.timer !== null && restore?.timer !== undefined) {
      clearTimeout(restore.timer);
    }
    this.restore = null;
  }

  private captureLocationState(identity: GuideIdentity): void {
    if (!this.runtime || this.captureGuardKey === makeGuideKey(identity)) {
      return;
    }
    const snapshot = readGuideScrollSnapshot(
      this.runtime.getLocation().state,
      identity.guideId,
    );
    if (snapshot) {
      this.recordPosition(identity, snapshot.scrollTop);
    }
  }

  private captureCurrentPosition(): void {
    const runtime = this.runtime;
    const identity = this.readActiveGuide();
    if (
      !runtime ||
      !identity ||
      this.captureGuardKey === makeGuideKey(identity) ||
      this.restore?.guideKey === makeGuideKey(identity)
    ) {
      return;
    }

    const scroller = runtime.getGuideScroller();
    if (scroller && isScrollTop(scroller.scrollTop)) {
      this.recordPosition(identity, scroller.scrollTop);
    } else {
      this.captureLocationState(identity);
    }
  }

  private captureKnownScrollerPosition(
    identity: GuideIdentity,
    element: HTMLElement | null,
  ): void {
    const guideKey = makeGuideKey(identity);
    if (
      !element ||
      this.captureGuardKey === guideKey ||
      this.restore?.guideKey === guideKey ||
      !isScrollTop(element.scrollTop)
    ) {
      return;
    }

    this.recordPosition(identity, element.scrollTop);
  }

  private recordPosition(
    identity: GuideIdentity,
    scrollTop: number,
    allowDestructiveZero = false,
  ): void {
    const guideKey = makeGuideKey(identity);
    const previous = this.positions.get(guideKey);

    if (scrollTop > RESTORE_EPSILON) {
      this.clearPendingZeroCapture();
    } else if (
      previous &&
      previous.scrollTop > RESTORE_EPSILON &&
      (!allowDestructiveZero || !this.canConfirmZeroCapture(guideKey))
    ) {
      return;
    } else if (previous && previous.scrollTop > RESTORE_EPSILON) {
      this.armZeroCapture(identity);
      return;
    }

    this.commitPosition(identity, scrollTop);
  }

  private canConfirmZeroCapture(guideKey: string): boolean {
    const now = Date.now();
    return (
      (this.lastScrollIntent?.guideKey === guideKey &&
        now - this.lastScrollIntent.at <= SCROLL_INTENT_WINDOW_MS) ||
      (this.lastNonzeroScroll?.guideKey === guideKey &&
        now - this.lastNonzeroScroll.at <= RECENT_SCROLL_WINDOW_MS)
    );
  }

  private armZeroCapture(identity: GuideIdentity): void {
    const runtime = this.runtime;
    const scroller = runtime?.getGuideScroller() ?? null;
    if (!runtime || !scroller) {
      return;
    }

    const guideKey = makeGuideKey(identity);
    if (
      this.pendingZeroCapture?.guideKey === guideKey &&
      this.pendingZeroCapture.scrollerElement === scroller.element
    ) {
      return;
    }

    this.clearPendingZeroCapture();
    const pending: PendingZeroCapture = {
      identity,
      guideKey,
      scrollerElement: scroller.element,
      timer: setTimeout(() => {
        if (this.pendingZeroCapture !== pending) {
          return;
        }
        this.pendingZeroCapture = null;

        const activeGuide = this.readActiveGuide();
        const currentScroller = this.runtime?.getGuideScroller() ?? null;
        if (
          !sameGuide(activeGuide, identity) ||
          this.captureGuardKey === guideKey ||
          this.restore?.guideKey === guideKey ||
          !currentScroller ||
          currentScroller.element !== pending.scrollerElement ||
          !currentScroller.element.isConnected ||
          currentScroller.scrollTop > RESTORE_EPSILON
        ) {
          return;
        }

        this.commitPosition(identity, currentScroller.scrollTop);
      }, ZERO_SCROLL_CONFIRM_MS),
    };
    this.pendingZeroCapture = pending;
  }

  private clearPendingZeroCapture(): void {
    if (!this.pendingZeroCapture) {
      return;
    }
    clearTimeout(this.pendingZeroCapture.timer);
    this.pendingZeroCapture = null;
  }

  private clearGuideActivity(): void {
    this.lastScrollIntent = null;
    this.lastNonzeroScroll = null;
  }

  private commitPosition(identity: GuideIdentity, scrollTop: number): void {
    const guideKey = makeGuideKey(identity);
    const previous = this.positions.get(guideKey);
    const pending = this.pendingScrollTops.get(guideKey);
    if (
      !this.failedSaves.has(guideKey) &&
      (pending === scrollTop ||
        (pending === undefined && previous?.scrollTop === scrollTop))
    ) {
      return;
    }

    this.failedSaves.delete(guideKey);
    this.positions.set(guideKey, { scrollTop, updatedAt: Date.now() });
    this.pendingScrollTops.set(guideKey, scrollTop);
    this.saveRetries.delete(guideKey);
    this.status.update({
      phase: "watching",
      savedCount: this.persistedKeys.size,
      activeGuide: identity,
      lastCaptured: { ...identity, scrollTop },
      message: `Captured ${Math.round(scrollTop)} px`,
    });

    const existingTimer = this.saveTimers.get(guideKey);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }
    this.saveTimers.set(
      guideKey,
      setTimeout(() => this.flushKey(guideKey), SAVE_DEBOUNCE_MS),
    );
  }

  private flushActiveGuide(): void {
    if (this.activeGuide) {
      this.flushKey(makeGuideKey(this.activeGuide));
    }
  }

  private flushAll(): void {
    for (const guideKey of [...this.pendingScrollTops.keys()]) {
      this.flushKey(guideKey);
    }
  }

  private flushKey(guideKey: string): void {
    const timer = this.saveTimers.get(guideKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.saveTimers.delete(guideKey);
    }

    const scrollTop = this.pendingScrollTops.get(guideKey);
    if (scrollTop === undefined) {
      return;
    }
    this.pendingScrollTops.delete(guideKey);

    this.saveQueue.push({ guideKey, scrollTop });
    this.pumpSaveQueue();
  }

  private pumpSaveQueue(): void {
    if (this.saveInFlight) {
      return;
    }
    const next = this.saveQueue.shift();
    if (!next) {
      return;
    }

    this.saveInFlight = true;
    void this.persistPosition(next).finally(() => {
      this.saveInFlight = false;
      this.pumpSaveQueue();
    });
  }

  private async persistPosition({
    guideKey,
    scrollTop,
  }: QueuedSave): Promise<void> {
    try {
      await this.backend.savePosition(guideKey, scrollTop);
      this.persistedKeys.add(guideKey);
      this.saveRetries.delete(guideKey);
      this.failedSaves.delete(guideKey);
      const currentStatus = this.status.getSnapshot();
      this.status.update({
        phase: "watching",
        savedCount: this.persistedKeys.size,
        message:
          currentStatus.phase === "error" &&
          currentStatus.message.startsWith("Could not save the guide position")
            ? "Watching Steam guides"
            : currentStatus.message,
      });
    } catch (error: unknown) {
      this.reportError("Could not save the guide position", error);
      const current = this.positions.get(guideKey)?.scrollTop;
      const retryCount = this.saveRetries.get(guideKey) ?? 0;
      if (
        current === scrollTop &&
        !this.pendingScrollTops.has(guideKey) &&
        retryCount < MAX_SAVE_RETRIES &&
        !this.disposed
      ) {
        this.saveRetries.set(guideKey, retryCount + 1);
        this.pendingScrollTops.set(guideKey, scrollTop);
        this.saveTimers.set(
          guideKey,
          setTimeout(() => this.flushKey(guideKey), SAVE_RETRY_MS),
        );
      } else if (current === scrollTop) {
        this.failedSaves.add(guideKey);
      }
    }
  }

  private armCaptureGuard(guideKey: string): void {
    this.clearCaptureGuard();
    this.captureGuardKey = guideKey;
    this.captureGuardTimer = setTimeout(() => {
      this.captureGuardTimer = null;
      if (this.captureGuardKey !== guideKey) {
        return;
      }
      this.captureGuardKey = null;
      if (!this.restore) {
        this.lastScrollerElement = null;
      }
      this.handleLifecycle();
      this.handleHistoryChange();
    }, SELECTION_HANDOFF_MS);
  }

  private clearCaptureGuard(): void {
    if (this.captureGuardTimer !== null) {
      clearTimeout(this.captureGuardTimer);
      this.captureGuardTimer = null;
    }
    this.captureGuardKey = null;
  }

  private reportError(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[GRIP] ${context}`, error);
    this.status.update({ phase: "error", message: `${context}: ${detail}` });
  }
}
