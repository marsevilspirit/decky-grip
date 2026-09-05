import type { DownloadedGuide } from "./types";
import type { GuideIdentity } from "../steam/guide-key";

export interface GuideImageDownloadProgress {
  completed: number;
  total: number;
}

/** Save all images, without sending their bytes through the frontend. */
export async function downloadGuideImages(
  guide: DownloadedGuide,
  downloadImage: (url: string) => Promise<boolean>,
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
  let firstError: unknown;
  const pending = urls.values();
  const progress = () => onProgress?.({ completed, total: urls.size });
  progress();
  await Promise.all(
    Array.from({ length: Math.min(3, urls.size) }, async () => {
      for (const url of pending) {
        if (signal?.aborted) break;
        try {
          if (!(await downloadImage(url))) {
            throw new Error("图片未保存");
          }
          completed += 1;
        } catch (error: unknown) {
          firstError ??= error;
        }
        progress();
      }
    }),
  );
  signal?.throwIfAborted();
  if (completed !== urls.size) {
    const traceback =
      firstError &&
      typeof firstError === "object" &&
      "pythonTraceback" in firstError
        ? String(firstError.pythonTraceback)
            .trim()
            .split("\n")
            .pop()
            ?.replace(/^Exception: /, "")
        : null;
    const reason =
      (firstError instanceof Error ? firstError.message : null) ||
      traceback ||
      "图片保存失败，请检查网络和本地剩余空间";
    throw new Error(
      `图片仅保存 ${completed}/${urls.size}，尚未完整离线。${reason}；重试会保留已下载的图片。`,
    );
  }
}

export interface GuideDownloadTask {
  phase: "downloading" | "canceling" | "canceled" | "complete" | "failed";
  progress: GuideImageDownloadProgress | null;
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
  start(identity: GuideIdentity): Promise<void> {
    const { guideId } = identity;
    const existing = this.active.get(guideId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const finish = (phase: GuideDownloadTask["phase"]) => {
      this.active.delete(guideId);
      for (const id of this.tasks.keys()) {
        if (this.tasks.size <= 20) break;
        if (!this.active.has(id) && id !== guideId) this.tasks.delete(id);
      }
      this.publish(guideId, {
        phase,
        progress: this.tasks.get(guideId)?.progress ?? null,
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
        ),
      )
      .then(
        () => finish(controller.signal.aborted ? "canceled" : "complete"),
        () => finish(controller.signal.aborted ? "canceled" : "failed"),
      );
    this.active.set(guideId, { controller, promise });
    this.publish(guideId, { phase: "downloading", progress: null });
    return promise;
  }
  cancel(guideId: string): void {
    const active = this.active.get(guideId);
    if (!active || active.controller.signal.aborted) return;
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
