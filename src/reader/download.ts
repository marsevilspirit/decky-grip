import type { DownloadedGuide } from "./types";
import type { GuideIdentity } from "../steam/guide-key";

export interface GuideImageDownloadProgress {
  completed: number;
  total: number;
  failed?: number;
  error?: string;
  stopped?: boolean;
  publishing?: boolean;
}

export type GuideImageDownloadResult =
  { saved: true } | { saved: false; kind: string; error: string };

export interface PreparedGuide {
  token: string;
  guide: DownloadedGuide;
}

function downloadErrorMessage(error: unknown): string {
  const traceback =
    error && typeof error === "object" && "pythonTraceback" in error
      ? String(error.pythonTraceback)
          .trim()
          .split("\n")
          .pop()
          ?.replace(/^Exception: /, "")
      : null;
  return (
    (error instanceof Error ? error.message : null) ||
    traceback ||
    "图片保存失败，请检查网络和本地剩余空间"
  );
}

/** Publish only after every image is safely on disk; cancellation keeps the old version. */
export async function downloadOfflineGuide(
  guideId: string,
  forceRefresh: boolean,
  backend: {
    prepareGuide: (
      guideId: string,
      forceRefresh: boolean,
    ) => Promise<PreparedGuide>;
    commitGuide: (guideId: string, token: string) => Promise<DownloadedGuide>;
    discardGuide: (guideId: string, token: string) => Promise<boolean>;
    downloadGuideImage: (url: string) => Promise<GuideImageDownloadResult>;
  },
  onProgress?: (progress: GuideImageDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadedGuide> {
  signal?.throwIfAborted();
  const candidate = await backend.prepareGuide(guideId, forceRefresh);
  try {
    let progress: GuideImageDownloadProgress = { completed: 0, total: 0 };
    await downloadGuideImages(
      candidate.guide,
      backend.downloadGuideImage,
      (next) => {
        progress = next;
        onProgress?.(next);
      },
      signal,
    );
    signal?.throwIfAborted();
    onProgress?.({ ...progress, publishing: true });
    return await backend.commitGuide(guideId, candidate.token);
  } finally {
    // Commit consumes the token. Cancellation releases staging and makes unused images evictable retry cache.
    await backend
      .discardGuide(guideId, candidate.token)
      .catch((error: unknown) =>
        console.warn("[GRIP] Could not discard a prepared guide", error),
      );
  }
}

/** Save all images, without sending their bytes through the frontend. */
export async function downloadGuideImages(
  guide: DownloadedGuide,
  downloadImage: (url: string) => Promise<GuideImageDownloadResult>,
  onProgress?: (progress: GuideImageDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const urls = new Set<string>();
  const template = document.createElement("template");
  for (const section of guide.sections) {
    template.innerHTML = section.html;
    for (const image of template.content.querySelectorAll<HTMLImageElement>(
      "img[data-grip-image-url]",
    )) {
      const url = image.dataset.gripImageUrl;
      if (url) urls.add(url);
    }
  }
  let completed = 0;
  let failed = 0;
  let errorMessage: string | undefined;
  let stopped = false;
  const pending = urls.values();
  const progress = () =>
    onProgress?.({
      completed,
      total: urls.size,
      ...(failed ? { failed, error: errorMessage } : {}),
      ...(stopped ? { stopped: true } : {}),
    });
  progress();
  await Promise.all(
    Array.from({ length: Math.min(3, urls.size) }, async () => {
      for (const url of pending) {
        if (signal?.aborted || stopped) break;
        try {
          const result = await downloadImage(url);
          if (!result.saved) {
            if (result.kind === "capacity") {
              stopped = true;
              errorMessage = result.error;
            }
            throw new Error(result.error);
          }
          completed += 1;
        } catch (error: unknown) {
          failed += 1;
          if (!stopped) errorMessage = downloadErrorMessage(error);
        }
        progress();
      }
    }),
  );
  signal?.throwIfAborted();
  if (completed !== urls.size) {
    throw new Error(
      `图片仅保存 ${completed}/${urls.size}，尚未完整离线。${errorMessage}；重试会复用仍在缓存的图片。`,
    );
  }
}

export interface GuideDownloadTask {
  phase: "downloading" | "canceling" | "canceled" | "complete" | "failed";
  progress: GuideImageDownloadProgress | null;
  error?: string;
}

/** Plugin-lifetime jobs survive native-page unmounts; content is shared by guide id. */
export class GuideDownloadTasks {
  private readonly tasks = new Map<string, GuideDownloadTask>();
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly download: (
      identity: GuideIdentity,
      onProgress: (progress: GuideImageDownloadProgress) => void,
      signal: AbortSignal,
      forceRefresh: boolean,
    ) => Promise<unknown>,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot(guideId: string): GuideDownloadTask | null {
    return this.tasks.get(guideId) ?? null;
  }
  hasActive(): boolean {
    return this.active.size > 0;
  }
  private publish(guideId: string, task: GuideDownloadTask) {
    this.tasks.set(guideId, task);
    for (const listener of this.listeners) listener();
  }
  start(identity: GuideIdentity, forceRefresh = false): Promise<void> {
    const { guideId } = identity;
    const existing = this.active.get(guideId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const finish = (phase: GuideDownloadTask["phase"], error?: string) => {
      this.active.delete(guideId);
      for (const id of this.tasks.keys()) {
        if (this.tasks.size <= 20) break;
        if (!this.active.has(id) && id !== guideId) this.tasks.delete(id);
      }
      this.publish(guideId, {
        phase,
        progress: this.tasks.get(guideId)?.progress ?? null,
        ...(error ? { error } : {}),
      });
    };
    const promise = Promise.resolve()
      .then(() =>
        this.download(
          identity,
          (progress) => {
            this.publish(guideId, {
              phase: controller.signal.aborted ? "canceling" : "downloading",
              progress,
            });
          },
          controller.signal,
          forceRefresh,
        ),
      )
      .then(
        () => finish(controller.signal.aborted ? "canceled" : "complete"),
        (error: unknown) =>
          finish(
            controller.signal.aborted ? "canceled" : "failed",
            controller.signal.aborted ? undefined : downloadErrorMessage(error),
          ),
      );
    this.active.set(guideId, { controller, promise });
    this.publish(guideId, { phase: "downloading", progress: null });
    return promise;
  }
  cancel(guideId: string): void {
    const active = this.active.get(guideId);
    if (
      !active ||
      active.controller.signal.aborted ||
      this.tasks.get(guideId)?.progress?.publishing
    )
      return;
    active.controller.abort();
    this.publish(guideId, {
      phase: "canceling",
      progress: this.tasks.get(guideId)?.progress ?? null,
    });
  }
  dispose(): void {
    for (const id of this.active.keys()) this.cancel(id);
    this.listeners.clear();
  }
}
