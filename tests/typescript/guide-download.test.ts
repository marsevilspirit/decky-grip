// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

import * as backend from "../../src/backend";
import { downloadGuide } from "../../src/guide-download";
import { renderInSteamBrowser } from "../../src/steam/import-browser";
import type { RenderedHeyboxGuide } from "../../src/import/heybox";
import type { DownloadedGuide } from "../../src/reader/types";

vi.mock("../../src/backend", () => ({
  prepareGuide: vi.fn(),
  prepareImportedGuide: vi.fn(),
  commitGuide: vi.fn(),
  commitImportedGuide: vi.fn(),
  discardGuide: vi.fn(),
  downloadGuideImage: vi.fn(),
  captureHeybox: vi.fn(),
  cancelHeyboxCapture: vi.fn(),
}));
vi.mock("../../src/steam/import-browser", () => ({
  renderInSteamBrowser: vi.fn(),
}));

const identity = { appId: "1113000", guideId: "heybox-249c72219fed" };
const rendered: RenderedHeyboxGuide = {
  guideId: identity.guideId,
  title: "截图攻略",
  author: "作者",
  sourceUrl: "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed",
  sections: [{ id: "1", title: "正文", html: "<p>完整正文</p>" }],
  imageUrls: [],
};
const guide: DownloadedGuide = {
  ...rendered,
  fetchedAt: 1,
  fromCache: true,
  stale: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(renderInSteamBrowser).mockResolvedValue(rendered);
  vi.mocked(backend.prepareGuide).mockResolvedValue({ token: "steam", guide });
  vi.mocked(backend.prepareImportedGuide).mockResolvedValue({
    token: "imported",
    guide,
  });
  vi.mocked(backend.commitGuide).mockResolvedValue(guide);
  vi.mocked(backend.commitImportedGuide).mockResolvedValue(guide);
  vi.mocked(backend.discardGuide).mockResolvedValue(true);
  vi.mocked(backend.downloadGuideImage).mockResolvedValue({ saved: true });
});

it("keeps Steam downloads on the native transaction and forwards refresh", async () => {
  const progress = vi.fn();
  const steamIdentity = { appId: "1113000", guideId: "123" };
  const steamGuide = { ...guide, guideId: "123" };
  vi.mocked(backend.prepareGuide).mockResolvedValue({
    token: "steam",
    guide: steamGuide,
  });
  vi.mocked(backend.commitGuide).mockResolvedValue(steamGuide);
  expect(await downloadGuide(steamIdentity, progress, undefined, true)).toBe(
    steamGuide,
  );
  expect(backend.prepareGuide).toHaveBeenCalledExactlyOnceWith("123", true);
  expect(backend.commitGuide).toHaveBeenCalledExactlyOnceWith("123", "steam");
  expect(backend.discardGuide).toHaveBeenCalledExactlyOnceWith("123", "steam");
  expect(progress).toHaveBeenLastCalledWith({
    completed: 0,
    total: 0,
    publishing: true,
  });
  expect(renderInSteamBrowser).not.toHaveBeenCalled();
  expect(backend.prepareImportedGuide).not.toHaveBeenCalled();
  expect(backend.commitImportedGuide).not.toHaveBeenCalled();
});

it("captures Heybox and publishes with its game association through the shared transaction", async () => {
  const signal = new AbortController().signal;
  expect(await downloadGuide(identity, undefined, signal)).toBe(guide);
  expect(renderInSteamBrowser).toHaveBeenCalledExactlyOnceWith(
    rendered.sourceUrl,
    backend.captureHeybox,
    signal,
    backend.cancelHeyboxCapture,
  );
  expect(backend.prepareImportedGuide).toHaveBeenCalledExactlyOnceWith(
    rendered,
  );
  expect(backend.commitImportedGuide).toHaveBeenCalledExactlyOnceWith(
    identity.guideId,
    "imported",
    identity.appId,
  );
  expect(backend.discardGuide).toHaveBeenCalledExactlyOnceWith(
    identity.guideId,
    "imported",
  );
  expect(backend.prepareGuide).not.toHaveBeenCalled();
  expect(backend.commitGuide).not.toHaveBeenCalled();
});

it("does not prepare a late capture after cancellation", async () => {
  const controller = new AbortController();
  vi.mocked(renderInSteamBrowser).mockImplementation(async () => {
    controller.abort();
    return rendered;
  });
  await expect(
    downloadGuide(identity, undefined, controller.signal),
  ).rejects.toThrow();
  expect(backend.prepareImportedGuide).not.toHaveBeenCalled();
  expect(backend.commitImportedGuide).not.toHaveBeenCalled();
});

it("does not render or prepare a pre-canceled download", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    downloadGuide(identity, undefined, controller.signal),
  ).rejects.toThrow();
  expect(renderInSteamBrowser).not.toHaveBeenCalled();
  expect(backend.prepareImportedGuide).not.toHaveBeenCalled();
});

it("discards incomplete imported images without publishing", async () => {
  const imageUrl = "https://imgheybox.max-c.com/bbs/example.webp";
  vi.mocked(backend.prepareImportedGuide).mockResolvedValue({
    token: "imported",
    guide: {
      ...guide,
      sections: [
        {
          id: "1",
          title: "正文",
          html: `<img data-grip-image-url="${imageUrl}">`,
        },
      ],
    },
  });
  vi.mocked(backend.downloadGuideImage).mockResolvedValue({
    saved: false,
    kind: "network",
    error: "图片下载失败",
  });
  await expect(downloadGuide(identity)).rejects.toThrow("0/1");
  expect(backend.downloadGuideImage).toHaveBeenCalledExactlyOnceWith(imageUrl);
  expect(backend.commitImportedGuide).not.toHaveBeenCalled();
  expect(backend.discardGuide).toHaveBeenCalledExactlyOnceWith(
    identity.guideId,
    "imported",
  );
});

it("propagates association errors instead of claiming import success", async () => {
  vi.mocked(backend.commitImportedGuide).mockRejectedValue(
    new Error("游戏关联失败"),
  );
  await expect(downloadGuide(identity)).rejects.toThrow("游戏关联失败");
  expect(backend.commitGuide).not.toHaveBeenCalled();
  expect(backend.discardGuide).toHaveBeenCalledExactlyOnceWith(
    identity.guideId,
    "imported",
  );
});
