import { restoreReaderPosition } from "./anchor";
import {
  isReaderScrollInteraction,
  ReaderCheckpoint,
  readerRestoreCanSettle,
} from "./checkpoint";
import type { ReaderPositionOutcome } from "./performance";
import type { ReaderSessionSnapshot } from "./session-cache";
import type { ReaderViewport } from "./viewport";

const STABLE_MS = 100;
const TIMEOUT_MS = 10_000;
const SEARCH_MARGIN = 48;
const INTERACTIONS = ["wheel", "touchmove", "pointerdown", "keydown"];

interface RestoreCallbacks {
  onOutcome: (outcome: ReaderPositionOutcome) => void;
  onTimeout: () => void;
  onStable: () => void;
}

/** One positioning operation owns the document at a time; observers belong to ReaderViewport. */
export class ReaderPositioning {
  private operation: { kind: "restore" | "search"; update: () => void } | null =
    null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(
    private readonly viewport: ReaderViewport,
    private readonly checkpoint: ReaderCheckpoint,
    private readonly onInterrupted: (reason: string) => void,
  ) {
    for (const event of INTERACTIONS)
      viewport.scroller.addEventListener(event, this.interact, true);
  }

  get restoring(): boolean {
    return this.operation?.kind === "restore";
  }

  private readonly interact = (event: Event): void => {
    if (!isReaderScrollInteraction(event, this.viewport.scroller)) return;
    this.checkpoint.intendScroll();
    this.cancelRestore("用户在阅读位置稳定前开始操作");
    this.stopSearch();
  };

  layoutChanged(): void {
    this.operation?.update();
  }

  cancelRestore(reason?: string): void {
    if (!this.restoring) return;
    if (reason) this.onInterrupted(reason);
    this.stop();
  }

  stopSearch(): void {
    if (this.operation?.kind === "search") this.stop();
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private stop(): void {
    this.operation = null;
    this.clearStableTimer();
    if (this.deadline !== null) clearTimeout(this.deadline);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.deadline = null;
    this.frame = null;
  }

  restore(snapshot: ReaderSessionSnapshot, callbacks: RestoreCallbacks): void {
    if (this.disposed) return;
    this.stop();
    this.checkpoint.block();
    const { position, positionWarning, guide } = snapshot;
    if (!position && positionWarning === null) this.checkpoint.settle();
    const { scroller, content, anchors } = this.viewport;
    let timedOut = false;
    let lastApplied: number | null = null;
    const ready = () => {
      if (!this.viewport.imagesReady) return false;
      const allSections = content.children.length >= guide.sections.length;
      if (!position)
        return allSections || scroller.scrollHeight >= scroller.clientHeight;
      const anchorReady =
        !position.anchorText ||
        anchors.candidates(position.anchorText, position.sectionId).length > 0;
      const target = Math.min(
        position.scrollTop,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );
      return readerRestoreCanSettle(
        allSections,
        position.anchorText !== null,
        anchorReady,
        Math.abs(scroller.scrollTop - target) <= 1,
      );
    };
    const apply = () => {
      const top = position
        ? restoreReaderPosition(scroller, content, position, anchors)
        : scroller.scrollTop;
      this.viewport.measure();
      const moved = lastApplied !== null && Math.abs(top - lastApplied) > 1;
      lastApplied = top;
      return moved;
    };
    const operation = {
      kind: "restore" as const,
      update: () => {
        if (this.operation !== operation) return;
        const moved = apply();
        if (this.operation !== operation) return;
        if (!ready()) {
          this.clearStableTimer();
          return;
        }
        if (moved) this.clearStableTimer();
        if (this.stableTimer !== null) return;
        this.stableTimer = setTimeout(
          () => {
            if (this.operation !== operation) return;
            this.stableTimer = null;
            const moved = apply();
            if (this.operation !== operation) return;
            if (moved || !ready()) {
              operation.update();
              return;
            }
            if (!timedOut) {
              callbacks.onOutcome(
                positionWarning ||
                  [...this.viewport.visibleImages].some(
                    (image) =>
                      image.isConnected &&
                      image.dataset.gripImageState !== "ready",
                  )
                  ? "unavailable"
                  : position
                    ? "restored"
                    : "skipped",
              );
            }
            this.stop();
            if (positionWarning === null) this.checkpoint.settle();
            callbacks.onStable();
          },
          position || this.viewport.visibleImages.size > 0 ? STABLE_MS : 0,
        );
      },
    };
    this.operation = operation;
    this.frame = requestAnimationFrame(() => {
      if (this.operation !== operation) return;
      this.frame = requestAnimationFrame(() => {
        if (this.operation !== operation) return;
        this.frame = null;
        operation.update();
      });
    });
    this.deadline = setTimeout(() => {
      if (this.operation !== operation) return;
      this.deadline = null;
      // A restore timeout reports degraded readiness, but keeps correcting late image layout.
      timedOut = true;
      callbacks.onOutcome("unavailable");
      callbacks.onTimeout();
      operation.update();
    }, TIMEOUT_MS);
  }

  search(range: Range, onScroll: () => void): void {
    if (this.disposed) return;
    this.stop();
    const { scroller } = this.viewport;
    const align = (force: boolean) => {
      if (!range.startContainer.isConnected) return;
      const next = Math.max(
        0,
        Math.min(
          scroller.scrollTop +
            range.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            SEARCH_MARGIN,
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        ),
      );
      if (!force && Math.abs(next - scroller.scrollTop) <= 1) return;
      this.checkpoint.intendScroll();
      scroller.scrollTop = next;
      onScroll();
    };
    const operation = {
      kind: "search" as const,
      update: () => {
        if (this.operation === operation) align(false);
      },
    };
    this.operation = operation;
    align(true);
    this.deadline = setTimeout(() => {
      if (this.operation !== operation) return;
      this.deadline = null;
      operation.update();
      // Search follows late layout only for a bounded interval, unlike bookmark restoration.
      this.stop();
    }, TIMEOUT_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const event of INTERACTIONS)
      this.viewport.scroller.removeEventListener(event, this.interact, true);
  }
}
