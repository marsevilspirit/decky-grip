export interface CachedGuideImage {
  mimeType: string;
  base64: string;
  fromCache: boolean;
  width: number;
  height: number;
}

export type GuideImageFetcher = (
  url: string,
  allowDownload: boolean,
) => Promise<CachedGuideImage | null>;

interface HydratableImage {
  dataset: DOMStringMap;
  isConnected: boolean;
  src: string;
  removeAttribute(name: string): void;
}

interface ImageRoot {
  querySelectorAll<E extends Element = Element>(
    selectors: string,
  ): NodeListOf<E>;
}

interface PendingImageUrl {
  generation: number;
  images: Set<HydratableImage>;
  url: string;
}

interface BlobEntry {
  bytes: number;
  images: Set<HydratableImage>;
  objectUrl: string;
}

type ObjectUrlFactory = (image: CachedGuideImage) => string;
export type ImageHydrationPredicate = (image: HTMLImageElement) => boolean;

interface RectElement {
  getBoundingClientRect(): DOMRect;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_BLOB_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BLOB_ENTRIES = 64;
const DEFAULT_MAX_PENDING_URLS = 48;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function createImageObjectUrl(image: CachedGuideImage): string {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(image.mimeType)) {
    throw new TypeError("backend returned a non-image MIME type");
  }
  const binary = atob(image.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function residentImageBytes(image: CachedGuideImage): number {
  if (
    !Number.isSafeInteger(image.width) ||
    image.width < 1 ||
    !Number.isSafeInteger(image.height) ||
    image.height < 1
  ) {
    throw new TypeError("backend returned invalid image dimensions");
  }
  const decodedBytes = image.width * image.height * 4;
  if (!Number.isSafeInteger(decodedBytes)) {
    throw new TypeError("backend returned excessive image dimensions");
  }
  return Math.max(decodedBase64Bytes(image.base64), decodedBytes);
}

export function isImageNearViewport(
  image: RectElement,
  scroller: RectElement,
  overscanScreens = 1.5,
): boolean {
  const viewport = scroller.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  const viewportHeight = Math.max(1, viewport.bottom - viewport.top);
  const overscan = Math.max(0, overscanScreens) * viewportHeight;
  return (
    imageRect.bottom >= viewport.top - overscan &&
    imageRect.top <= viewport.bottom + overscan
  );
}

/**
 * Resolves only caller-selected inert image nodes through the backend cache.
 * Requests and Blob URLs are shared per canonical URL, while a frontend LRU
 * bounds CEF-resident blobs independently of the backend disk/memory quotas.
 */
export class ReaderImageHydrator {
  private readonly queue: PendingImageUrl[] = [];
  private readonly pendingByUrl = new Map<string, PendingImageUrl>();
  private readonly blobs = new Map<string, BlobEntry>();
  private readonly imageUrls = new WeakMap<object, string>();
  private readonly capacityDeferredAt = new WeakMap<object, number>();
  private readonly pendingOverflow = new Set<HydratableImage>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly pinnedUrls = new Set<string>();
  private active = 0;
  private blobBytes = 0;
  private generation = 0;
  private pinGeneration = 0;
  private pinningActive = false;

  constructor(
    private readonly fetchImage: GuideImageFetcher,
    private readonly concurrency = DEFAULT_CONCURRENCY,
    private readonly makeObjectUrl: ObjectUrlFactory = createImageObjectUrl,
    private readonly revokeObjectUrl: (url: string) => void = (url) =>
      URL.revokeObjectURL(url),
    private readonly maxBlobBytes = DEFAULT_MAX_BLOB_BYTES,
    private readonly maxBlobEntries = DEFAULT_MAX_BLOB_ENTRIES,
    private readonly maxPendingUrls = DEFAULT_MAX_PENDING_URLS,
  ) {
    for (const [label, value] of [
      ["concurrency", concurrency],
      ["maxBlobBytes", maxBlobBytes],
      ["maxBlobEntries", maxBlobEntries],
      ["maxPendingUrls", maxPendingUrls],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
      }
    }
  }

  hydrate(
    root: ImageRoot,
    shouldHydrate: ImageHydrationPredicate = () => true,
  ): void {
    const images = [
      ...root.querySelectorAll<HTMLImageElement>("img[data-grip-image-url]"),
    ].filter(shouldHydrate);
    this.hydrateImages(images);
  }

  /** Pins the current near-viewport working set so LRU eviction cannot thrash it. */
  setPinnedImages(images: Iterable<HydratableImage>): void {
    this.pinningActive = true;
    const nextPinnedUrls = new Set<string>();
    for (const image of images) {
      const url = image.dataset.gripImageUrl;
      if (url && image.isConnected) {
        nextPinnedUrls.add(url);
      }
    }
    const changed =
      nextPinnedUrls.size !== this.pinnedUrls.size ||
      [...nextPinnedUrls].some((url) => !this.pinnedUrls.has(url));
    if (changed) {
      this.pinGeneration += 1;
      this.pinnedUrls.clear();
      for (const url of nextPinnedUrls) {
        this.pinnedUrls.add(url);
      }
    }
    this.pruneUnpinnedQueue();
  }

  hydrateImages(images: Iterable<HydratableImage>): void {
    for (const image of images) {
      this.pendingOverflow.delete(image);
      const url = image.dataset.gripImageUrl;
      if (!url || !image.isConnected) {
        image.dataset.gripImageState = "unavailable";
        continue;
      }
      if (image.dataset.gripImageState === "unavailable") {
        continue;
      }
      if (this.capacityDeferredAt.get(image) === this.pinGeneration) {
        continue;
      }

      const blob = this.blobs.get(url);
      if (blob) {
        this.touchBlob(url, blob);
        this.assignBlob(image, url, blob);
        continue;
      }

      const pending = this.pendingByUrl.get(url);
      if (pending) {
        pending.images.add(image);
        this.imageUrls.set(image, url);
        image.dataset.gripImageState = "queued";
        continue;
      }

      if (this.pendingByUrl.size >= this.maxPendingUrls) {
        image.dataset.gripImageState = "deferred";
        this.pendingOverflow.add(image);
        continue;
      }

      const task: PendingImageUrl = {
        generation: this.generation,
        images: new Set([image]),
        url,
      };
      this.pendingByUrl.set(url, task);
      this.imageUrls.set(image, url);
      image.dataset.gripImageState = "queued";
      this.queue.push(task);
    }
    this.pump();
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  clear(): void {
    this.generation += 1;
    this.queue.length = 0;
    this.pendingByUrl.clear();
    this.pendingOverflow.clear();
    this.pinnedUrls.clear();
    this.pinGeneration += 1;
    this.pinningActive = false;
    for (const [url, blob] of this.blobs) {
      this.evictBlob(url, blob);
    }
    this.blobs.clear();
    this.blobBytes = 0;
    this.resolveIdleIfReady();
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const task = this.queue.shift();
      if (!task) {
        break;
      }
      this.active += 1;
      void this.load(task).finally(() => {
        this.active -= 1;
        if (this.pendingByUrl.get(task.url) === task) {
          this.pendingByUrl.delete(task.url);
        }
        this.refillPendingOverflow();
        this.pump();
        this.resolveIdleIfReady();
      });
    }
    this.resolveIdleIfReady();
  }

  private async load(task: PendingImageUrl): Promise<void> {
    for (const image of task.images) {
      image.dataset.gripImageState = "loading";
    }
    try {
      const result = await this.fetchImage(task.url, true);
      if (task.generation !== this.generation) {
        return;
      }
      if (!result) {
        this.markUnavailable(task);
        return;
      }
      if (this.pinningActive && !this.pinnedUrls.has(task.url)) {
        this.markDeferred(task);
        return;
      }
      const connected = [...task.images].filter((image) => image.isConnected);
      if (connected.length === 0) {
        return;
      }
      const bytes = residentImageBytes(result);
      if (bytes > this.maxBlobBytes) {
        this.markUnavailable(task);
        return;
      }
      if (!this.evictToFit(bytes)) {
        this.markCapacityDeferred(task);
        return;
      }
      const objectUrl = this.makeObjectUrl(result);
      if (task.generation !== this.generation) {
        this.revokeObjectUrl(objectUrl);
        return;
      }
      const blob: BlobEntry = {
        bytes,
        images: new Set(),
        objectUrl,
      };
      this.blobs.set(task.url, blob);
      this.blobBytes += bytes;
      for (const image of connected) {
        this.assignBlob(image, task.url, blob);
      }
    } catch (error: unknown) {
      console.warn("[GRIP] Could not hydrate a cached guide image", error);
      if (task.generation === this.generation) {
        this.markUnavailable(task);
      }
    }
  }

  private assignBlob(
    image: HydratableImage,
    url: string,
    blob: BlobEntry,
  ): void {
    if (!image.isConnected) {
      return;
    }
    this.imageUrls.set(image, url);
    this.capacityDeferredAt.delete(image);
    blob.images.add(image);
    if (image.src !== blob.objectUrl) {
      image.src = blob.objectUrl;
    }
    image.dataset.gripImageState = "ready";
  }

  private markUnavailable(task: PendingImageUrl): void {
    for (const image of task.images) {
      if (image.isConnected && this.imageUrls.get(image) === task.url) {
        image.dataset.gripImageState = "unavailable";
        this.capacityDeferredAt.delete(image);
      }
    }
  }

  private markCapacityDeferred(task: PendingImageUrl): void {
    for (const image of task.images) {
      if (image.isConnected && this.imageUrls.get(image) === task.url) {
        image.dataset.gripImageState = "deferred";
        this.capacityDeferredAt.set(image, this.pinGeneration);
        this.imageUrls.delete(image);
      }
    }
  }

  private markDeferred(task: PendingImageUrl): void {
    for (const image of task.images) {
      if (image.isConnected && this.imageUrls.get(image) === task.url) {
        image.dataset.gripImageState = "deferred";
        this.capacityDeferredAt.delete(image);
        this.imageUrls.delete(image);
      }
    }
  }

  private touchBlob(url: string, blob: BlobEntry): void {
    this.blobs.delete(url);
    this.blobs.set(url, blob);
  }

  private evictToFit(incomingBytes: number): boolean {
    while (
      this.blobs.size >= this.maxBlobEntries ||
      this.blobBytes + incomingBytes > this.maxBlobBytes
    ) {
      const oldest = [...this.blobs.entries()].find(
        ([url]) => !this.pinningActive || !this.pinnedUrls.has(url),
      );
      if (!oldest) {
        return false;
      }
      this.blobs.delete(oldest[0]);
      this.evictBlob(oldest[0], oldest[1]);
    }
    return true;
  }

  private pruneUnpinnedQueue(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const task = this.queue[index];
      if (this.pinnedUrls.has(task.url)) {
        continue;
      }
      this.queue.splice(index, 1);
      if (this.pendingByUrl.get(task.url) === task) {
        this.pendingByUrl.delete(task.url);
      }
      this.markDeferred(task);
    }
    for (const image of this.pendingOverflow) {
      const url = image.dataset.gripImageUrl;
      if (!image.isConnected || !url || !this.pinnedUrls.has(url)) {
        this.pendingOverflow.delete(image);
      }
    }
    this.resolveIdleIfReady();
  }

  private refillPendingOverflow(): void {
    if (this.pendingOverflow.size === 0) {
      return;
    }
    const available = this.maxPendingUrls - this.pendingByUrl.size;
    if (available <= 0) {
      return;
    }
    const candidates: HydratableImage[] = [];
    for (const image of this.pendingOverflow) {
      this.pendingOverflow.delete(image);
      const url = image.dataset.gripImageUrl;
      if (
        image.isConnected &&
        url &&
        (!this.pinningActive || this.pinnedUrls.has(url))
      ) {
        candidates.push(image);
      }
      if (candidates.length >= available) {
        break;
      }
    }
    this.hydrateImages(candidates);
  }

  private evictBlob(url: string, blob: BlobEntry): void {
    this.revokeObjectUrl(blob.objectUrl);
    this.blobBytes = Math.max(0, this.blobBytes - blob.bytes);
    for (const image of blob.images) {
      if (this.imageUrls.get(image) !== url || image.src !== blob.objectUrl) {
        continue;
      }
      image.removeAttribute("src");
      image.dataset.gripImageState = "evicted";
      this.imageUrls.delete(image);
    }
  }

  private resolveIdleIfReady(): void {
    if (this.active !== 0 || this.queue.length !== 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}
