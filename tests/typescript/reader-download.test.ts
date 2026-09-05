// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";

import {
  downloadGuideImages,
  GuideDownloadTasks,
} from "../../src/reader/download";
import type { DownloadedGuide } from "../../src/reader/types";

it("shares an in-flight download across pages, cancels later requests and resumes saved images", async () => {
  const guide: DownloadedGuide = {
    guideId: "1",
    title: "Guide",
    author: "A",
    fetchedAt: 1,
    sourceUrl: "",
    fromCache: true,
    stale: false,
    sections: [
      {
        id: "1",
        title: "Chapter",
        html: Array.from(
          { length: 7 },
          (_, i) =>
            `<img data-grip-image-url="https://images.steamusercontent.com/${i}.png">`,
        ).join(""),
      },
    ],
  };
  const saved = new Set<string>();
  const pending: Array<() => void> = [];
  const fetch = vi.fn(async (url: string) => {
    if (saved.has(url)) return true;
    await new Promise<void>((resolve) => pending.push(resolve));
    saved.add(url);
    return true;
  });
  const tick = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const run = vi.fn(async (_identity, progress, signal) =>
    downloadGuideImages(guide, fetch, progress, signal),
  );
  const tasks = new GuideDownloadTasks(run);
  const firstListener = vi.fn();
  const unsubscribe = tasks.subscribe(firstListener);
  const first = tasks.start({ appId: "10", guideId: "1" });
  await tick();
  expect(fetch).toHaveBeenCalledTimes(3);
  unsubscribe(); // Native page went away. Another AppID still shares the same content job.
  expect(tasks.start({ appId: "20", guideId: "1" })).toBe(first);
  expect(tasks.getSnapshot("1")).toEqual({
    phase: "downloading",
    progress: { completed: 0, total: 7 },
  });
  tasks.subscribe(() => {
    if (tasks.getSnapshot("1")?.phase === "canceled")
      expect(tasks.hasActive()).toBe(false);
  });
  tasks.cancel("1");
  expect(tasks.getSnapshot("1")?.phase).toBe("canceling");
  expect(tasks.hasActive()).toBe(true);
  pending.splice(0).forEach((resolve) => resolve());
  await first;
  expect(saved.size).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(tasks.hasActive()).toBe(false);
  expect(tasks.getSnapshot("1")).toEqual({
    phase: "canceled",
    progress: { completed: 3, total: 7 },
  });
  const secondListener = vi.fn();
  tasks.subscribe(secondListener);
  const resumed = tasks.start({ appId: "10", guideId: "1" });
  await tick();
  expect(tasks.getSnapshot("1")?.progress?.completed).toBe(3);
  for (let i = 0; i < 10 && tasks.hasActive(); i++) {
    pending.splice(0).forEach((resolve) => resolve());
    await tick();
  }
  expect(tasks.hasActive()).toBe(false);
  await resumed;
  expect(saved.size).toBe(7);
  expect(tasks.getSnapshot("1")?.phase).toBe("complete");
  expect(run).toHaveBeenCalledTimes(2);
  expect(secondListener).toHaveBeenCalled();
});

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
