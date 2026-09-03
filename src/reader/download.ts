import type { DownloadedGuide } from "./types";

export interface GuideImageDownloadProgress {
  completed: number;
  total: number;
}

/** Save all images, without sending their bytes through the frontend. */
export async function downloadGuideImages(
  guide: DownloadedGuide,
  downloadImage: (url: string) => Promise<boolean>,
  onProgress?: (progress: GuideImageDownloadProgress) => void,
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
