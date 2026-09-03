// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";

import { downloadGuideImages } from "../../src/reader/download";
import type { DownloadedGuide } from "../../src/reader/types";

it("waits for every unique image, limits concurrency, and resumes partial downloads", async () => {
  const urls = Array.from(
    { length: 5 },
    (_, index) => `https://images.steamusercontent.com/${index}?a=1&b=2`,
  );
  const guide: DownloadedGuide = {
    guideId: "1",
    title: "离线指南",
    author: "作者",
    sourceUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=1",
    fetchedAt: 1,
    fromCache: true,
    stale: false,
    sections: [0, 1].map((index) => ({
      id: String(index),
      title: "章节",
      html: urls
        .map(
          (url) => `<img data-grip-image-url="${url.replace(/&/g, "&amp;")}">`,
        )
        .join(""),
    })),
  };
  const disk = new Set([urls[0]]);
  const requests: string[] = [];
  const pending = new Map<string, () => void>();
  let failing = true;
  let maxConcurrent = 0;
  const downloadImage = vi.fn(async (url: string) => {
    if (disk.has(url)) return true;
    requests.push(url);
    await new Promise<void>((resolve) => {
      pending.set(url, resolve);
      maxConcurrent = Math.max(maxConcurrent, pending.size);
    });
    if (failing && url === urls[1]) {
      throw Object.assign(new Error(), {
        name: "Python Exception",
        pythonTraceback:
          "Traceback (most recent call last):\nException: 网络中断\n",
      });
    }
    disk.add(url);
    return true;
  });
  const progress = vi.fn();
  const tick = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  const release = () => {
    const current = [...pending.values()];
    pending.clear();
    current.forEach((resolve) => resolve());
  };

  let settled = false;
  const first = downloadGuideImages(guide, downloadImage, progress);
  const failed = expect(first).rejects.toThrow(
    "图片仅保存 4/5，尚未完整离线。网络中断",
  );
  void first.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await tick();
  expect(pending.size).toBe(3);
  expect(settled).toBe(false);
  release();
  await tick();
  expect(pending.size).toBe(1);
  expect(settled).toBe(false);
  release();
  await failed;
  expect(progress).toHaveBeenLastCalledWith({ completed: 4, total: 5 });
  expect(downloadImage).toHaveBeenCalledTimes(5);
  expect(maxConcurrent).toBe(3);

  failing = false;
  const retry = downloadGuideImages(guide, downloadImage, progress);
  await tick();
  expect([...pending.keys()]).toEqual([urls[1]]);
  release();
  await retry;
  expect(progress).toHaveBeenLastCalledWith({ completed: 5, total: 5 });
  expect(requests).toHaveLength(5);
  expect(disk.size).toBe(5);

  await downloadGuideImages(
    { ...guide, sections: [] },
    downloadImage,
    progress,
  );
  expect(progress).toHaveBeenLastCalledWith({ completed: 0, total: 0 });
});
