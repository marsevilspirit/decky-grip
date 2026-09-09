import { ReaderAnchorIndex } from "./anchor";
import type { ReaderImageCacheControl } from "./image-cache-control";
import type { ReaderImageHydrator } from "./image-hydrator";

const MAX_ACTIVE_IMAGES = 512;
const RETRY_SELECTOR =
  'img[data-grip-image-state="unavailable"], img[data-grip-image-state="capacity"]';

export interface ReaderImageRetry {
  image: HTMLImageElement;
  host: HTMLSpanElement;
  key: number;
  busy: boolean;
}

export interface ReaderViewportSnapshot {
  activeSectionId: string | null;
  retryImage: HTMLImageElement | null;
  previewImage: HTMLImageElement | null;
  retries: ReaderImageRetry[];
}

/** Owns one rendered document's observers, image nodes and frame scheduling. */
export class ReaderViewport {
  readonly anchors: ReaderAnchorIndex;
  readonly visibleImages = new Set<HTMLImageElement>();
  private readonly nearImages = new Set<HTMLImageElement>();
  private readonly pendingImages = new Set<HTMLImageElement>();
  private readonly observedSections = new WeakSet<Element>();
  private readonly controls = new Map<HTMLImageElement, ReaderImageRetry>();
  private readonly intersection: IntersectionObserver | null;
  private readonly resize: ResizeObserver;
  private readonly mutations: MutationObserver;
  private readonly unsubscribeCache: () => void;
  private frame: number | null = null;
  private disposed = false;
  private nextKey = 0;
  private snapshot: ReaderViewportSnapshot = {
    activeSectionId: null,
    retryImage: null,
    previewImage: null,
    retries: [],
  };

  constructor(
    readonly scroller: HTMLElement,
    readonly content: HTMLElement,
    private readonly hydrator: ReaderImageHydrator,
    private readonly cacheControl: ReaderImageCacheControl,
    private readonly onSnapshot: (snapshot: ReaderViewportSnapshot) => void,
    private readonly onLayout: () => void,
  ) {
    this.anchors = new ReaderAnchorIndex(content);
    hydrator.releaseImages();
    this.intersection =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (this.disposed) return;
              for (const entry of entries) {
                const image = entry.target as HTMLImageElement;
                this.pendingImages.delete(image);
                if (entry.isIntersecting && image.isConnected)
                  this.nearImages.add(image);
                else this.nearImages.delete(image);
              }
              this.measure();
              if (!this.disposed) this.onLayout();
            },
            { root: scroller, rootMargin: "150% 0px 150% 0px" },
          );
    this.resize = new ResizeObserver(this.layoutChanged);
    this.resize.observe(scroller);
    this.resize.observe(content);
    content.addEventListener("load", this.layoutChanged, true);
    content.addEventListener("error", this.imageFailed, true);
    this.mutations = new MutationObserver(() => this.synchronizeRetries());
    this.mutations.observe(content, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-grip-image-state"],
    });
    this.unsubscribeCache = cacheControl.subscribe(() => {
      if (cacheControl.getSnapshot().paused) hydrator.clear();
      else this.schedule();
    });
    cacheControl.resume();
    if (cacheControl.getSnapshot().paused) hydrator.clear();
  }

  get imagesReady(): boolean {
    return (
      this.pendingImages.size === 0 &&
      [...this.visibleImages].every((image) => {
        const state = image.dataset.gripImageState;
        return (
          !image.isConnected ||
          state === "unavailable" ||
          state === "capacity" ||
          (state === "ready" && image.complete)
        );
      })
    );
  }

  /** Called after progressive sections mount, before measuring their placeholders. */
  syncSections(): void {
    if (this.disposed) return;
    this.anchors.refresh();
    const images: HTMLImageElement[] = [];
    for (const section of this.content.children) {
      if (this.observedSections.has(section)) continue;
      this.observedSections.add(section);
      images.push(
        ...section.querySelectorAll<HTMLImageElement>(
          "img[data-grip-image-url]",
        ),
      );
    }
    // Warm dimensions precede observation, so collapsed placeholders do not all look visible.
    if (!this.cacheControl.getSnapshot().paused)
      this.hydrator.hydrateImages(images, true);
    for (const image of images) {
      if (this.intersection) {
        this.pendingImages.add(image);
        this.intersection.observe(image);
      } else this.nearImages.add(image);
    }
    this.synchronizeRetries();
    if (!this.intersection) this.measure();
    this.schedule();
  }

  readonly schedule = (): void => {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.frame = null;
      this.measure();
      if (!this.disposed) this.onLayout();
    });
  };

  // Position correction stays synchronous with layout changes; ordinary scrolling is frame-coalesced.
  private readonly layoutChanged = (): void => {
    if (this.disposed) return;
    this.schedule();
    this.onLayout();
  };

  private readonly imageFailed = (event: Event): void => {
    if (this.disposed) return;
    const image = event.target as HTMLImageElement | null;
    if (image?.tagName === "IMG" && image.dataset.gripImageUrl)
      image.dataset.gripImageState = "unavailable";
    this.layoutChanged();
  };

  /** Pure viewport work: it does not recursively notify the active positioning operation. */
  measure(): void {
    if (this.disposed) return;
    for (const image of this.nearImages)
      if (!image.isConnected) this.nearImages.delete(image);
    const connected = [...this.nearImages];
    const viewport = this.scroller.getBoundingClientRect();
    const measured = connected.map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        image,
        visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
        distance: Math.max(
          viewport.top - rect.bottom,
          rect.top - viewport.bottom,
          0,
        ),
      };
    });
    this.visibleImages.clear();
    for (const { image, visible } of measured)
      if (visible) this.visibleImages.add(image);
    const paused = this.cacheControl.getSnapshot().paused;
    // Repeated icons may reuse a Blob without spending another RPC/decoded slot.
    if (!paused) this.hydrator.hydrateImages(connected, true);
    const candidates = measured
      .filter(
        ({ image }) =>
          image.dataset.gripImageState !== "ready" &&
          image.dataset.gripImageState !== "unavailable",
      )
      .sort(
        (left, right) =>
          Number(right.visible) - Number(left.visible) ||
          Number(left.image.dataset.gripImageState === "capacity") -
            Number(right.image.dataset.gripImageState === "capacity") ||
          left.distance - right.distance,
      )
      .slice(0, MAX_ACTIVE_IMAGES)
      .map(({ image }) => image);
    this.hydrator.setPinnedImages(this.visibleImages, candidates);
    if (!paused) this.hydrator.hydrateImages(candidates);
    const sections = this.content.children;
    let low = 0;
    let high = sections.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sections[middle].getBoundingClientRect().top <= viewport.top + 1)
        low = middle + 1;
      else high = middle;
    }
    this.updateSnapshot(
      (sections[Math.max(0, low - 1)] as HTMLElement | undefined)?.dataset
        .guideSectionId ?? null,
    );
  }

  private synchronizeRetries(): void {
    if (this.disposed) return;
    for (const image of this.content.querySelectorAll<HTMLImageElement>(
      RETRY_SELECTOR,
    )) {
      if (this.controls.has(image)) continue;
      const host = image.ownerDocument.createElement("span");
      host.style.display = "block";
      image.after(host);
      this.controls.set(image, {
        image,
        host,
        key: ++this.nextKey,
        busy: false,
      });
    }
    const retries: ReaderImageRetry[] = [];
    for (const [image, control] of this.controls) {
      const state = image.dataset.gripImageState;
      const busy =
        state === "queued" || state === "loading" || state === "deferred";
      if (
        !image.isConnected ||
        (!busy && state !== "unavailable" && state !== "capacity")
      ) {
        if (
          control.host.contains(control.host.ownerDocument.activeElement) &&
          !this.scroller.closest("[inert], [hidden]")
        ) {
          try {
            this.scroller.focus({ preventScroll: true });
          } catch {
            this.scroller.focus();
          }
        }
        control.host.remove();
        this.controls.delete(image);
      } else retries.push({ ...control, busy });
    }
    this.updateSnapshot(this.snapshot.activeSectionId, retries);
  }

  private updateSnapshot(
    activeSectionId = this.snapshot.activeSectionId,
    retries = this.snapshot.retries,
  ): void {
    if (this.disposed) return;
    let retryImage: HTMLImageElement | null = null;
    let previewImage: HTMLImageElement | null = null;
    for (const image of this.visibleImages) {
      if (!image.isConnected) continue;
      const precedes = (other: HTMLImageElement | null) =>
        !other ||
        Boolean(
          image.compareDocumentPosition(other) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      const state = image.dataset.gripImageState;
      if (
        (state === "unavailable" || state === "capacity") &&
        precedes(retryImage)
      )
        retryImage = image;
      if (state === "ready" && precedes(previewImage)) previewImage = image;
    }
    const previous = this.snapshot;
    if (
      previous.activeSectionId === activeSectionId &&
      previous.retryImage === retryImage &&
      previous.previewImage === previewImage &&
      previous.retries.length === retries.length &&
      previous.retries.every(
        (entry, index) =>
          entry.image === retries[index].image &&
          entry.host === retries[index].host &&
          entry.busy === retries[index].busy,
      )
    )
      return;
    this.snapshot = { activeSectionId, retryImage, previewImage, retries };
    this.onSnapshot(this.snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.unsubscribeCache();
    this.resize.disconnect();
    this.intersection?.disconnect();
    this.mutations.disconnect();
    this.content.removeEventListener("load", this.layoutChanged, true);
    this.content.removeEventListener("error", this.imageFailed, true);
    for (const { host } of this.controls.values()) host.remove();
    this.controls.clear();
    this.nearImages.clear();
    this.visibleImages.clear();
    this.pendingImages.clear();
    this.hydrator.releaseImages();
  }
}
