// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { renderInSteamBrowser } from "../../src/steam/import-browser";
import { readerBelongsToStoppedApp } from "../../src/hotkey/reader-toggle";
import type { RenderedHeyboxGuide } from "../../src/import/heybox";

const url = "https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858";
const article: RenderedHeyboxGuide = {
  guideId: "heybox-8a79701fa858",
  sourceUrl: url,
  title: "公开攻略",
  author: "作者",
  sections: [{ id: "1", title: "正文", html: "<p>攻略</p>" }],
  imageUrls: [],
};
function steam() {
  const view = {
    SetBounds: vi.fn(),
    SetVisible: vi.fn(),
    SetBlockedProtocols: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    LoadURL: vi.fn(),
  };
  const browser = { Create: vi.fn(() => view), Destroy: vi.fn() };
  vi.stubGlobal("SteamClient", { BrowserView: browser });
  return { view, browser };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("owns a unique marked page and destroys it after capture, with no persistent browser", async () => {
  const { view, browser } = steam();
  const capture = vi.fn(async () => article);
  expect(await renderInSteamBrowser(url, capture)).toEqual(article);
  const marker = capture.mock.calls[0] as unknown as [string, string];
  expect(marker[0]).toBe(url);
  expect(marker[1]).toMatch(/^[a-f0-9]{32}$/);
  expect(view.LoadURL).toHaveBeenCalledWith(`${url}#grip-import-${marker[1]}`);
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
});
it("cleans up failed capture and rejects cancellation even after capture returns", async () => {
  const { view, browser } = steam();
  await expect(
    renderInSteamBrowser(url, async () => {
      throw new Error("缺图");
    }),
  ).rejects.toThrow("缺图");
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
  browser.Destroy.mockClear();
  const controller = new AbortController();
  await expect(
    renderInSteamBrowser(
      url,
      async () => {
        controller.abort();
        return article;
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
});
it("does not create a browser for an invalid link or pre-canceled import", async () => {
  const { browser } = steam();
  await expect(
    renderInSteamBrowser("https://evil.test", async () => article),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    renderInSteamBrowser(url, async () => article, controller.signal),
  ).rejects.toThrow();
  expect(browser.Create).not.toHaveBeenCalled();
});
it("cancels immediately even while CEF discovery has not replied", async () => {
  steam();
  const controller = new AbortController();
  const cancel = vi.fn(async () => {});
  const pending = renderInSteamBrowser(
    url,
    () => new Promise(() => {}),
    controller.signal,
    cancel,
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancel).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/));
});
it("preserves immediate cancellation if the backend cancel call throws", async () => {
  const { view, browser } = steam();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const controller = new AbortController();
  const cancel = vi.fn(() => {
    throw new Error("RPC unavailable");
  });
  const pending = renderInSteamBrowser(
    url,
    () => new Promise(() => {}),
    controller.signal,
    cancel,
  );
  controller.abort(new Error("用户取消"));
  await expect(pending).rejects.toThrow("用户取消");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
});
it("stops reading a page that navigates away and closes imported reader on game exit", async () => {
  const { view, browser } = steam();
  await expect(
    renderInSteamBrowser(url, async () => {
      view.on.mock.calls[0][1]("https://example.org");
      return article;
    }),
  ).rejects.toThrow("跳转");
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
  expect(
    readerBelongsToStoppedApp(
      "/decky-grip/reader/1113000/heybox-8a79701fa858",
      1113000,
      false,
    ),
  ).toBe(true);
});
it("rejects navigation immediately and cancels a capture still awaiting discovery", async () => {
  const { view, browser } = steam();
  let finish!: (guide: RenderedHeyboxGuide) => void;
  const cancel = vi.fn(async () => {});
  const pending = renderInSteamBrowser(
    url,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    undefined,
    cancel,
  );
  const settled = vi.fn();
  void pending.then(settled, settled);
  try {
    view.on.mock.calls[0][1]("https://example.org");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("跳转") }),
    );
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^[a-f0-9]{32}$/),
    );
    expect(view.off).toHaveBeenCalledExactlyOnceWith(
      "start-request",
      view.on.mock.calls[0][1],
    );
    expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
  } finally {
    finish(article);
    await pending.catch(() => {});
  }
});
it("does not start capture when loading the page synchronously navigates away", async () => {
  const { view, browser } = steam();
  view.LoadURL.mockImplementation(() => {
    view.on.mock.calls[0][1]("https://example.org");
  });
  const capture = vi.fn(async () => article);
  await expect(renderInSteamBrowser(url, capture)).rejects.toThrow("跳转");
  expect(capture).not.toHaveBeenCalled();
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
});
it("still destroys the view and preserves the capture error when listener cleanup fails", async () => {
  const { view, browser } = steam();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  view.off.mockImplementation(() => {
    throw new Error("view.off failed");
  });
  await expect(
    renderInSteamBrowser(url, async () => {
      throw new Error("缺图");
    }),
  ).rejects.toThrow("缺图");
  expect(browser.Destroy).toHaveBeenCalledExactlyOnceWith(view);
});
