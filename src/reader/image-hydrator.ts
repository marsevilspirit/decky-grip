import { normalizeAnchorText } from "./anchor";
import type { DownloadedGuide, ReaderPosition } from "./types";

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
  width: number;
  height: number;
  removeAttribute(name: string): void;
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
  width: number;
  height: number;
}

type ObjectUrlFactory = (image: CachedGuideImage) => string;

const DEFAULT_CONCURRENCY = 3;
// Must fit one image accepted by the backend's 16-megapixel limit.
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BLOB_ENTRIES = 64;
const DEFAULT_MAX_PENDING_URLS = 48;
const MAX_PRELOAD_IMAGES = 3;
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

function nearbyImageUrls(
  guide: DownloadedGuide,
  position: ReaderPosition | null,
): string[] {
  const savedSection = guide.sections.findIndex(
    (section) => section.id === position?.sectionId,
  );
  // A legacy pixel-only bookmark cannot identify nearby images without laying out the article.
  if (savedSection < 0 && position?.scrollTop) return [];
  const start = Math.max(0, savedSection);
  const urls = new Set<string>();
  const template = document.createElement("template");
  for (const index of [start, start + 1, start - 1]) {
    const section = guide.sections[index];
    if (!section) continue;
    template.innerHTML = section.html;
    let images = [
      ...template.content.querySelectorAll<HTMLImageElement>(
        "img[data-grip-image-url]",
      ),
    ];
    if (index === start && position?.anchorText) {
      const walker = document.createTreeWalker(
        template.content,
        NodeFilter.SHOW_TEXT,
      );
      let anchor: Node | null;
      while ((anchor = walker.nextNode())) {
        if (
          normalizeAnchorText(anchor.textContent ?? "").startsWith(
            position.anchorText,
          )
        ) {
          const after = images.findIndex((image) =>
            Boolean(
              anchor!.compareDocumentPosition(image) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          );
          images =
            after < 0
              ? images.slice(-1)
              : [
                  images[after],
                  images[after - 1],
                  ...images.slice(after + 1),
                ].filter((image): image is HTMLImageElement => Boolean(image));
          break;
        }
      }
    }
    for (const image of images) {
      const url = image.dataset.gripImageUrl;
      if (url) urls.add(url);
      if (urls.size >= MAX_PRELOAD_IMAGES) return [...urls];
    }
  }
  return [...urls];
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
  private readonly pinnedUrls = new Set<string>();
  private readonly nearbyUrls = new Set<string>();
  private priorityUrl: string | null = null;
  private active = 0;
  private blobBytes = 0;
  private generation = 0;
  private pinGeneration = 0;
  private pinningActive = false;
  private preloadToken: object | null = null;
  private preloadOperation: Promise<void> = Promise.resolve();

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

  cancelPreload(): void {
    this.preloadToken = null;
  }

  /** Warm only local images near the bookmark, sharing the reader's existing LRU and RPC slots. */
  preloadGuide(
    guide: DownloadedGuide,
    position: ReaderPosition | null,
    canContinue: () => boolean,
  ): Promise<void> {
    const token = {};
    this.preloadToken = token;
    const current = () =>
      this.preloadToken === token && !this.pinningActive && canContinue();
    const operation = this.preloadOperation.then(async () => {
      if (!current() || this.active > 0) return;
      const warmed = new Set<string>();
      for (const url of nearbyImageUrls(guide, position)) {
        if (!current()) return;
        if (this.blobs.has(url)) {
          warmed.add(url);
          continue;
        }
        this.active += 1;
        try {
          const result = await this.fetchImage(url, false);
          if (!current()) return;
          if (!result) continue;
          const bytes = residentImageBytes(result);
          if (bytes > this.maxBlobBytes || !this.evictToFit(bytes, warmed))
            continue;
          const blob: BlobEntry = {
            bytes,
            images: new Set(),
            objectUrl: this.makeObjectUrl(result),
            width: result.width,
            height: result.height,
          };
          this.blobs.set(url, blob);
          this.blobBytes += bytes;
          warmed.add(url);
          const image = new Image();
          image.src = blob.objectUrl;
          try {
            await image.decode();
          } catch {
            if (this.blobs.get(url) === blob) {
              this.blobs.delete(url);
              this.evictBlob(url, blob);
            }
          } finally {
            image.removeAttribute("src");
          }
        } finally {
          this.active -= 1;
          this.pump();
        }
      }
    });
    this.preloadOperation = operation.catch(() => {});
    return operation;
  }

  /** Protect actual visible images; nearby preloads must remain evictable. */
  setPinnedImages(
    images: Iterable<HydratableImage>,
    nearbyImages?: Iterable<HydratableImage>,
  ): void {
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
    this.nearbyUrls.clear();
    for (const image of nearbyImages ?? []) {
      if (image.isConnected && image.dataset.gripImageUrl)
        this.nearbyUrls.add(image.dataset.gripImageUrl);
    }
    for (const url of this.pinnedUrls) this.nearbyUrls.add(url);
    if (this.priorityUrl && !this.pinnedUrls.has(this.priorityUrl))
      this.priorityUrl = null;
    this.pruneUnpinnedQueue();
    this.queue.sort(
      (left, right) =>
        Number(this.pinnedUrls.has(right.url)) -
        Number(this.pinnedUrls.has(left.url)),
    );
  }

  hydrateImages(images: Iterable<HydratableImage>, residentOnly = false): void {
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
      const blob = this.blobs.get(url);
      if (blob) {
        this.touchBlob(url, blob);
        this.assignBlob(image, url, blob);
        continue;
      }
      if (this.capacityDeferredAt.get(image) === this.pinGeneration) {
        continue;
      }
      if (residentOnly) continue;

      const pending = this.pendingByUrl.get(url);
      if (pending) {
        pending.images.add(image);
        this.imageUrls.set(image, url);
        image.dataset.gripImageState = "queued";
        continue;
      }

      if (
        this.pendingByUrl.size >= this.maxPendingUrls &&
        this.pinnedUrls.has(url)
      ) {
        const index = this.queue.findIndex(
          (task) => !this.pinnedUrls.has(task.url),
        );
        if (index >= 0) {
          const [displaced] = this.queue.splice(index, 1);
          this.pendingByUrl.delete(displaced.url);
          this.markDeferred(displaced);
        }
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
      if (this.pinnedUrls.has(url)) {
        const firstPreload = this.queue.findIndex(
          (pending) => !this.pinnedUrls.has(pending.url),
        );
        this.queue.splice(
          firstPreload < 0 ? this.queue.length : firstPreload,
          0,
          task,
        );
      } else this.queue.push(task);
    }
    if (!residentOnly) this.pump();
  }

  retryImage(image: HydratableImage): void {
    const url = image.dataset.gripImageUrl;
    if (
      !url ||
      !image.isConnected ||
      (image.dataset.gripImageState !== "unavailable" &&
        image.dataset.gripImageState !== "capacity")
    )
      return;
    if (image.dataset.gripImageState === "capacity") this.priorityUrl = url;
    const blob = this.blobs.get(url);
    const images = new Set([image, ...(blob?.images ?? [])]);
    if (blob) {
      this.blobs.delete(url);
      this.evictBlob(url, blob);
    }
    for (const candidate of images) {
      candidate.removeAttribute("src");
      candidate.dataset.gripImageState = "retrying";
      this.capacityDeferredAt.delete(candidate);
    }
    this.hydrateImages(images);
  }

  /** Detach the old page while retaining the bounded warm image cache. */
  releaseImages(): void {
    this.cancelPreload();
    this.generation += 1;
    this.queue.length = 0;
    for (const task of this.pendingByUrl.values()) {
      task.images.clear();
    }
    this.pendingByUrl.clear();
    this.pendingOverflow.clear();
    this.pinnedUrls.clear();
    this.nearbyUrls.clear();
    this.priorityUrl = null;
    this.pinGeneration += 1;
    this.pinningActive = false;
    for (const blob of this.blobs.values()) {
      blob.images.clear();
    }
  }

  clear(): void {
    for (const [url, blob] of this.blobs) {
      this.evictBlob(url, blob);
    }
    this.blobs.clear();
    this.blobBytes = 0;
    this.releaseImages();
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
      });
    }
  }

  private async load(task: PendingImageUrl): Promise<void> {
    for (const image of task.images) {
      image.dataset.gripImageState = "loading";
    }
    try {
      const result = await this.fetchImage(task.url, false);
      if (task.generation !== this.generation) {
        return;
      }
      if (!result) {
        this.markUnavailable(task);
        return;
      }
      if (this.pinningActive && !this.nearbyUrls.has(task.url)) {
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
      for (const image of connected) {
        image.width = result.width;
        image.height = result.height;
      }
      if (
        !this.evictToFit(
          bytes,
          task.url === this.priorityUrl ? new Set([task.url]) : this.pinnedUrls,
        )
      ) {
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
        width: result.width,
        height: result.height,
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
    image.width = blob.width;
    image.height = blob.height;
    if (image.src !== blob.objectUrl) {
      image.src = blob.objectUrl;
    }
    if (image.dataset.gripImageState !== "ready")
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
        image.dataset.gripImageState = this.pinnedUrls.has(task.url)
          ? "capacity"
          : "deferred";
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

  private evictToFit(
    incomingBytes: number,
    protectedUrls = this.pinnedUrls,
  ): boolean {
    while (
      this.blobs.size >= this.maxBlobEntries ||
      this.blobBytes + incomingBytes > this.maxBlobBytes
    ) {
      const oldest = [...this.blobs.entries()].find(
        ([url]) => !protectedUrls.has(url),
      );
      if (!oldest) {
        return false;
      }
      this.blobs.delete(oldest[0]);
      this.evictBlob(oldest[0], oldest[1], this.pinnedUrls.has(oldest[0]));
    }
    return true;
  }

  private pruneUnpinnedQueue(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const task = this.queue[index];
      if (this.nearbyUrls.has(task.url)) {
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
      if (!image.isConnected || !url || !this.nearbyUrls.has(url)) {
        this.pendingOverflow.delete(image);
      }
    }
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
    for (const image of [...this.pendingOverflow].sort(
      (left, right) =>
        Number(this.pinnedUrls.has(right.dataset.gripImageUrl ?? "")) -
        Number(this.pinnedUrls.has(left.dataset.gripImageUrl ?? "")),
    )) {
      this.pendingOverflow.delete(image);
      const url = image.dataset.gripImageUrl;
      if (
        image.isConnected &&
        url &&
        (!this.pinningActive || this.nearbyUrls.has(url))
      ) {
        candidates.push(image);
      }
      if (candidates.length >= available) {
        break;
      }
    }
    this.hydrateImages(candidates);
  }

  private evictBlob(url: string, blob: BlobEntry, capacity = false): void {
    this.revokeObjectUrl(blob.objectUrl);
    this.blobBytes = Math.max(0, this.blobBytes - blob.bytes);
    for (const image of blob.images) {
      if (this.imageUrls.get(image) !== url || image.src !== blob.objectUrl) {
        continue;
      }
      image.removeAttribute("src");
      image.dataset.gripImageState = capacity ? "capacity" : "evicted";
      if (this.pinningActive)
        this.capacityDeferredAt.set(image, this.pinGeneration);
      this.imageUrls.delete(image);
    }
  }
}
