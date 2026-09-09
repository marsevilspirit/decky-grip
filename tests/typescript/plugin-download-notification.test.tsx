// @vitest-environment happy-dom

import type { DefinePluginFn, ToastData } from "@decky/api";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createPlugin from "../../src/index";
import type { GripPanelProps } from "../../src/components/GripPanel";
import type { GuideReaderPageProps } from "../../src/components/GuideReaderPage";
import type {
  ImportGuideDraft,
  ImportGuideModal,
} from "../../src/components/ImportGuideModal";
import { GuideDownloadTasks } from "../../src/reader/download";
import type { GuideImageDownloadResult } from "../../src/reader/download";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";
import type { RuntimeStatusStore } from "../../src/runtime-status";
import type { GuideIdentity } from "../../src/steam/guide-key";
import type { SteamGuideRuntime } from "../../src/steam/runtime";

const steam = vi.hoisted(() => ({
  runningAppId: undefined as string | undefined,
  nativeGuide: null as GuideIdentity | null,
  historyListener: null as (() => void) | null,
  hotkeyListener: null as ((payload: unknown) => void) | null,
  backend: {
    get_positions: vi.fn(),
    get_guide_library: vi.fn(),
    get_cached_guide: vi.fn(),
    get_guide: vi.fn(),
    get_guide_image: vi.fn(),
    get_reader_position: vi.fn(),
    save_reader_position: vi.fn(),
    prepare_guide: vi.fn(),
    download_guide_image: vi.fn(),
    commit_guide: vi.fn(),
    discard_guide: vi.fn(),
    remove_offline_guide: vi.fn(),
  },
  toast: vi.fn<(data: ToastData) => void>(),
  showModal: vi.fn<
    (element: ReactElement<ComponentProps<typeof ImportGuideModal>>) => {
      Close: () => void;
    }
  >(),
  addGlobalComponent: vi.fn<
    (
      name: string,
      component: () => ReactElement<{
        downloads: GuideDownloadTasks;
        status: RuntimeStatusStore;
      }>,
    ) => void
  >(),
  navigate: vi.fn(),
  addRoute:
    vi.fn<
      (
        path: string,
        component: () => ReactElement<GuideReaderPageProps>,
      ) => void
    >(),
}));

// Keep index, the controller, download transaction/task manager, session cache and
// navigation function real. Only the Steam boundary and unrendered views are stubs.
vi.mock("@decky/api", () => ({
  definePlugin: (factory: DefinePluginFn) => factory,
  callable:
    (method: string) =>
    (...args: unknown[]) => {
      const handler = steam.backend[method as keyof typeof steam.backend];
      if (!handler) throw new Error(`Unexpected Steam backend call: ${method}`);
      return handler(...args);
    },
  addEventListener: (event: string, listener: (payload: unknown) => void) => {
    if (event === "grip_hotkey") steam.hotkeyListener = listener;
    return listener;
  },
  removeEventListener: vi.fn(),
  routerHook: {
    addRoute: steam.addRoute,
    removeRoute: vi.fn(),
    addGlobalComponent: steam.addGlobalComponent,
    removeGlobalComponent: vi.fn(),
  },
  toaster: { toast: steam.toast },
}));
vi.mock("@decky/ui", () => ({
  Router: {
    get MainRunningApp() {
      return steam.runningAppId
        ? { appid: Number(steam.runningAppId) }
        : undefined;
    },
    WindowStore: {
      GamepadUIMainWindowInstance: {
        History: { location: { pathname: "/library/home" } },
        Navigate: steam.navigate,
      },
    },
  },
  showModal: steam.showModal,
  staticClasses: { Title: "title" },
  useParams: () => ({ appId: "1113000", guideId: "123" }),
  beforePatch: vi.fn(),
  getGamepadNavigationTrees: () => [],
  getReactInstance: () => null,
  SideMenu: { Main: "main" },
}));
vi.mock("../../src/steam/runtime", () => ({
  createSteamGuideRuntime: (): SteamGuideRuntime => ({
    identity: steam,
    getLocation: () => ({ pathname: "/library/home" }),
    getActiveGuide: () => steam.nativeGuide,
    getGuideScroller: () => null,
    replaceLocationState: () => {},
    listenHistory: (listener) => {
      steam.historyListener = listener;
      return () => {
        steam.historyListener = null;
      };
    },
    listenGuideScroll: () => () => {},
    listenGuideInteraction: () => () => {},
    listenGuideLayout: () => () => {},
    listenWindowFocus: () => () => {},
    beforeGuideSelection: () => () => {},
  }),
}));
vi.mock("../../src/components/GuideDownloadButton", () => ({
  NativeGuideDownloadButton: () => null,
}));
vi.mock("../../src/components/GuideReaderPage", () => ({
  GuideReaderPage: () => null,
}));
vi.mock("../../src/components/GripPanel", () => ({ GripPanel: () => null }));
vi.mock("../../src/components/ImportGuideModal", () => ({
  ImportGuideModal: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const identity = { appId: "1113000", guideId: "123" };
const guide: DownloadedGuide = {
  guideId: identity.guideId,
  title: "已离线的图文攻略",
  author: "作者",
  sourceUrl: "https://steamcommunity.com/sharedfiles/filedetails/?id=123",
  fetchedAt: 1,
  fromCache: true,
  stale: false,
  sections: [
    {
      id: "chapter",
      title: "正文",
      html: '<img data-grip-image-url="https://images.steamusercontent.com/test.jpg">',
    },
  ],
};
const position: ReaderPosition = {
  scrollTop: 200,
  sectionId: "chapter",
  anchorText: "继续阅读",
  anchorOffset: 10,
  updatedAt: 1,
};
const localEntry = {
  ...identity,
  updatedAt: 1,
  cache: {
    title: guide.title,
    author: guide.author,
    fetchedAt: 1,
    sectionTitle: null,
    stale: false,
  },
};

describe("plugin download completion notification", () => {
  let plugin: ReturnType<typeof createPlugin>;
  let downloads: GuideDownloadTasks;
  let status: RuntimeStatusStore;
  const notification = () => steam.toast.mock.calls[0][0];
  const panel = () => (plugin.content as ReactElement<GripPanelProps>).props;
  const reader = () =>
    steam.addRoute.mock.calls[steam.addRoute.mock.calls.length - 1][1]().props;
  const restart = () => {
    plugin.onDismount?.();
    plugin = createPlugin();
    ({ downloads, status } =
      steam.addGlobalComponent.mock.calls[
        steam.addGlobalComponent.mock.calls.length - 1
      ][1]().props);
  };
  const observe = async (identity: GuideIdentity) => {
    await vi.waitFor(() => expect(steam.historyListener).not.toBeNull());
    steam.nativeGuide = identity;
    steam.historyListener!();
    await Promise.resolve();
    expect(status.getSnapshot().activeGuide).toEqual(identity);
  };
  const expectNoDownload = () => {
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
    expect(steam.backend.prepare_guide).not.toHaveBeenCalled();
    expect(steam.backend.download_guide_image).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.resetAllMocks();
    steam.runningAppId = undefined;
    steam.nativeGuide = null;
    steam.historyListener = null;
    steam.hotkeyListener = null;
    vi.spyOn(console, "info").mockImplementation(() => {});
    steam.backend.get_positions.mockResolvedValue({});
    steam.backend.get_guide_library.mockResolvedValue([]);
    steam.backend.get_cached_guide.mockResolvedValue(null);
    steam.backend.get_guide.mockResolvedValue(guide);
    steam.backend.get_guide_image.mockResolvedValue(null);
    steam.backend.get_reader_position.mockResolvedValue(position);
    steam.backend.save_reader_position.mockResolvedValue(position);
    steam.backend.prepare_guide.mockResolvedValue({ token: "prepared", guide });
    steam.backend.download_guide_image.mockResolvedValue({ saved: true });
    steam.backend.commit_guide.mockImplementation(async () => {
      steam.backend.get_cached_guide.mockResolvedValue(guide);
      return guide;
    });
    steam.backend.discard_guide.mockResolvedValue(true);
    plugin = createPlugin();
    ({ downloads, status } = steam.addGlobalComponent.mock.calls[0][1]().props);
  });
  afterEach(async () => {
    plugin.onDismount?.();
    await Promise.resolve();
    vi.restoreAllMocks();
  });

  it("does not preload a browsed Steam guide and only downloads after an explicit action", async () => {
    const { cache } = steam.addRoute.mock.calls[0][1]().props;
    await observe(identity);
    expect(steam.backend.get_cached_guide).not.toHaveBeenCalled();
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
    expect(steam.backend.prepare_guide).not.toHaveBeenCalled();
    expect(downloads.getSnapshot(identity.guideId)).toBeNull();

    await expect(cache.load(identity)).rejects.toThrow("下载到 GRIP");
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
    expect(steam.backend.prepare_guide).not.toHaveBeenCalled();
    expect(steam.backend.download_guide_image).not.toHaveBeenCalled();
    expect(steam.backend.commit_guide).not.toHaveBeenCalled();

    await downloads.start(identity);
    expect(steam.backend.prepare_guide).toHaveBeenCalledExactlyOnceWith(
      identity.guideId,
      false,
    );
    expect(steam.backend.download_guide_image).toHaveBeenCalledOnce();
    expect((await cache.load(identity)).guide).toBe(guide);
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
  });

  it.each([identity.appId, "730"])(
    "keeps locally opened A for the panel and L4 after browsing B from app %s",
    async (appId) => {
      steam.runningAppId = identity.appId;
      steam.backend.get_cached_guide.mockImplementation(async (guideId) =>
        guideId === identity.guideId ? guide : null,
      );
      await reader().onSwitchGuide(identity);
      await vi.waitFor(() =>
        expect(status.getRecentGuide(identity.appId)).toEqual(identity),
      );
      const browsed = { appId, guideId: "456" };
      await observe(browsed);
      steam.navigate.mockClear();
      // With no running game, the global local-recent choice must also ignore B.
      if (appId !== identity.appId) steam.runningAppId = undefined;
      await panel().openReader();
      await vi.waitFor(() => expect(steam.navigate).toHaveBeenCalledOnce());
      steam.runningAppId = identity.appId;
      steam.hotkeyListener!("L4");
      await vi.waitFor(() => expect(steam.navigate).toHaveBeenCalledTimes(2));
      expect(steam.navigate.mock.calls).toEqual(
        Array.from({ length: 2 }, () => [
          `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
          true,
        ]),
      );
      expect(
        steam.backend.get_cached_guide.mock.calls.every(
          ([guideId]) => guideId === identity.guideId,
        ),
      ).toBe(true);
      expect(status.getRecentGuide(identity.appId)).toEqual(identity);
      expectNoDownload();
    },
  );

  it("uses the downloaded library after restart, not the newer native reading position", async () => {
    steam.runningAppId = identity.appId;
    steam.backend.get_positions.mockResolvedValue({
      [`${identity.appId}:456`]: { scrollTop: 99, updatedAt: 100 },
    });
    steam.backend.get_guide_library.mockResolvedValue([localEntry]);
    steam.backend.get_cached_guide.mockImplementation(async (guideId) =>
      guideId === identity.guideId ? guide : null,
    );
    restart();
    await panel().openReader();
    expect(status.getSnapshot().savedCount).toBe(1);
    expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
      `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
      true,
    );
    expect(
      steam.backend.get_cached_guide.mock.calls.every(
        ([guideId]) => guideId === identity.guideId,
      ),
    ).toBe(true);
    expectNoDownload();
  });

  it("does not remember an explicitly opened guide whose local body is missing", async () => {
    steam.runningAppId = identity.appId;
    steam.backend.get_cached_guide.mockImplementation(async (guideId) =>
      guideId === identity.guideId ? guide : null,
    );
    await reader().onSwitchGuide(identity);
    await vi.waitFor(() =>
      expect(steam.backend.save_reader_position).toHaveBeenCalled(),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reader().onSwitchGuide({ ...identity, guideId: "456" });
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        "[GRIP] Reader content load failed",
        expect.any(Error),
      ),
    );
    expect(status.getRecentGuide(identity.appId)).toEqual(identity);
    steam.navigate.mockClear();
    await panel().openReader();
    expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
      `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
      true,
    );
    expectNoDownload();
  });

  it("forgets removed local B and ignores an older library response that could resurrect it", async () => {
    const removed = { ...identity, guideId: "456" };
    const oldLibrary = deferred<(typeof localEntry)[]>();
    const bodies = new Map([
      [identity.guideId, guide],
      [removed.guideId, { ...guide, guideId: removed.guideId }],
    ]);
    steam.runningAppId = identity.appId;
    steam.backend.get_cached_guide.mockImplementation(
      async (guideId) => bodies.get(guideId) ?? null,
    );
    steam.backend.get_guide_library
      .mockReturnValueOnce(oldLibrary.promise)
      .mockResolvedValue([localEntry]);
    steam.backend.remove_offline_guide.mockImplementation(async (guideId) => {
      bodies.delete(guideId);
      return { filesRemoved: 1, bytesRemoved: 100 };
    });
    restart();
    await reader().onSwitchGuide(removed);
    await vi.waitFor(() =>
      expect(status.getRecentGuide(identity.appId)).toEqual(removed),
    );
    await reader().onRemoveOffline(removed.guideId);
    expect(steam.backend.remove_offline_guide).toHaveBeenCalledExactlyOnceWith(
      removed.guideId,
    );
    expect(status.getRecentGuide(identity.appId)).toEqual(identity);
    oldLibrary.resolve([{ ...localEntry, ...removed, updatedAt: 100 }]);
    await oldLibrary.promise;
    await Promise.resolve();
    expect(status.getRecentGuide(identity.appId)).toEqual(identity);
    steam.navigate.mockClear();
    steam.backend.get_cached_guide.mockClear();
    await panel().openReader();
    expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
      `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
      true,
    );
    expect(
      steam.backend.get_cached_guide.mock.calls.every(
        ([guideId]) => guideId === identity.guideId,
      ),
    ).toBe(true);
    expectNoDownload();
  });

  it("waits for the cold local library instead of adopting native B before A arrives", async () => {
    const library = deferred<(typeof localEntry)[]>();
    steam.runningAppId = identity.appId;
    steam.nativeGuide = { ...identity, guideId: "456" };
    steam.backend.get_guide_library.mockReturnValue(library.promise);
    steam.backend.get_cached_guide.mockImplementation(async (guideId) =>
      guideId === identity.guideId ? guide : null,
    );
    restart();
    await vi.waitFor(() =>
      expect(status.getSnapshot().activeGuide).toEqual(steam.nativeGuide),
    );
    const opening = panel().openReader();
    await Promise.resolve();
    expect(steam.navigate).not.toHaveBeenCalled();
    expect(steam.backend.get_cached_guide).not.toHaveBeenCalled();
    library.resolve([localEntry]);
    await opening;
    expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
      `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
      true,
    );
    expectNoDownload();
  });

  it("asks for a download when the running game has no local guide rather than opening another app or native B", async () => {
    steam.runningAppId = "730";
    steam.nativeGuide = { appId: "730", guideId: "456" };
    steam.backend.get_guide_library.mockResolvedValue([localEntry]);
    restart();
    await expect(panel().openReader()).rejects.toThrow("下载");
    expect(steam.navigate).not.toHaveBeenCalled();
    expect(steam.backend.get_cached_guide).not.toHaveBeenCalled();
    expectNoDownload();
  });

  it("reads stale local guides without downloading and only refreshes on an explicit update", async () => {
    steam.backend.get_cached_guide.mockResolvedValue({ ...guide, stale: true });
    const { cache } = steam.addRoute.mock.calls[0][1]().props;
    expect((await cache.load(identity)).guide.stale).toBe(true);
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
    expect(steam.backend.prepare_guide).not.toHaveBeenCalled();

    steam.backend.get_cached_guide.mockResolvedValue(guide);
    await cache.load(identity, { forceRefresh: true });
    expect(steam.backend.prepare_guide).toHaveBeenCalledExactlyOnceWith(
      identity.guideId,
      true,
    );
    expect(steam.backend.download_guide_image).toHaveBeenCalledOnce();
    expect(steam.backend.get_guide).not.toHaveBeenCalled();
  });

  it("waits for complete images and the reading record, deduplicates the job, and only opens the clicked guide", async () => {
    const image = deferred<GuideImageDownloadResult>();
    const record = deferred<ReaderPosition>();
    steam.backend.download_guide_image.mockReturnValue(image.promise);
    steam.backend.save_reader_position.mockReturnValueOnce(record.promise);
    expect(downloads).toBeInstanceOf(GuideDownloadTasks);
    const pending = downloads.start(identity);
    expect(downloads.start(identity)).toBe(pending);
    await vi.waitFor(() =>
      expect(steam.backend.download_guide_image).toHaveBeenCalledOnce(),
    );
    expect(steam.backend.commit_guide).not.toHaveBeenCalled();
    expect(steam.toast).not.toHaveBeenCalled();
    image.resolve({ saved: true });
    await vi.waitFor(() =>
      expect(steam.backend.save_reader_position).toHaveBeenCalledOnce(),
    );
    expect(steam.backend.commit_guide).toHaveBeenCalledExactlyOnceWith(
      identity.guideId,
      "prepared",
    );
    expect(steam.toast).not.toHaveBeenCalled();
    expect(steam.navigate).not.toHaveBeenCalled();
    record.resolve(position);
    await pending;
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("complete");
    expect(steam.toast).toHaveBeenCalledOnce();
    expect(notification()).toMatchObject({
      title: "GRIP：图文已下载",
      body: guide.title,
      subtext: "点击阅读",
      playSound: false,
      onClick: expect.any(Function),
    });
    expect(steam.navigate).not.toHaveBeenCalled();
    status.rememberGuide({ appId: "730", guideId: "999" });
    notification().onClick!();
    notification().onClick!();
    await vi.waitFor(() =>
      expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
        `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
        true,
      ),
    );
    expect(steam.toast).toHaveBeenCalledOnce();
  });

  it("does not announce completion when an image fails", async () => {
    steam.backend.download_guide_image.mockResolvedValue({
      saved: false,
      kind: "network",
      error: "图片无法下载",
    });
    await downloads.start(identity);
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("failed");
    expect(steam.backend.commit_guide).not.toHaveBeenCalled();
    expect(steam.toast).toHaveBeenCalledOnce();
    expect(notification().title).toBe("GRIP：下载未完成");
    expect(notification().onClick).toBeUndefined();
    expect(steam.navigate).not.toHaveBeenCalled();
  });

  it("can reopen import with its draft after notification navigation closes the native modal without a close callback", async () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    // Native ShowModalResult.Close does not invoke fnOnClose.
    steam.showModal
      .mockReturnValueOnce({ Close: closeFirst })
      .mockReturnValueOnce({ Close: closeSecond });
    const openImport = (plugin.content as ReactElement<GripPanelProps>).props
      .openImport!;
    await openImport();
    expect(steam.showModal).toHaveBeenCalledOnce();
    const firstModal = steam.showModal.mock.calls[0][0];
    const draft: ImportGuideDraft = {
      text: "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed",
      game: { data: identity.appId, label: "女神异闻录4黄金版" },
      identity: { appId: identity.appId, guideId: "heybox-249c72219fed" },
    };
    firstModal.props.onDraftChange!(draft);
    await downloads.start(identity);
    expect(closeFirst).not.toHaveBeenCalled();
    notification().onClick!();
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(steam.navigate).toHaveBeenCalledExactlyOnceWith(
      `/decky-grip/reader/${identity.appId}/${identity.guideId}`,
      true,
    );
    await openImport();
    expect(steam.showModal).toHaveBeenCalledTimes(2);
    expect(steam.showModal.mock.calls[1][0].props.initialDraft).toEqual(draft);
    expect(closeSecond).not.toHaveBeenCalled();
  });

  it("does not announce completion after cancellation", async () => {
    const image = deferred<GuideImageDownloadResult>();
    steam.backend.download_guide_image.mockReturnValue(image.promise);
    const pending = downloads.start(identity);
    await vi.waitFor(() =>
      expect(steam.backend.download_guide_image).toHaveBeenCalledOnce(),
    );
    downloads.cancel(identity.guideId);
    image.resolve({ saved: true });
    await pending;
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("canceled");
    expect(steam.backend.commit_guide).not.toHaveBeenCalled();
    expect(steam.toast).not.toHaveBeenCalled();
    expect(steam.navigate).not.toHaveBeenCalled();
  });

  it("does not notify after unload even when publishing can no longer be canceled", async () => {
    const publish = deferred<DownloadedGuide>();
    steam.backend.commit_guide.mockReturnValue(publish.promise);
    const pending = downloads.start(identity);
    await vi.waitFor(() =>
      expect(steam.backend.commit_guide).toHaveBeenCalledOnce(),
    );
    expect(downloads.getSnapshot(identity.guideId)?.progress?.publishing).toBe(
      true,
    );
    plugin.onDismount?.();
    publish.resolve(guide);
    await pending;
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("complete");
    expect(steam.toast).not.toHaveBeenCalled();
    expect(steam.navigate).not.toHaveBeenCalled();
    expect(steam.backend.save_reader_position).not.toHaveBeenCalled();
  });

  it("ignores an old completion notification clicked after unload", async () => {
    await downloads.start(identity);
    const completed = notification();
    plugin.onDismount?.();
    completed.onClick!();
    await Promise.resolve();
    expect(steam.navigate).not.toHaveBeenCalled();
    expect(steam.toast).toHaveBeenCalledOnce();
  });

  it("combines a reading-record failure into one clickable completion warning", async () => {
    steam.backend.save_reader_position.mockRejectedValueOnce(
      new Error("阅读记录写入失败"),
    );
    await downloads.start(identity);
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("complete");
    expect(steam.toast).toHaveBeenCalledOnce();
    expect(notification()).toMatchObject({
      title: "GRIP：图文已下载，阅读记录保存失败",
      body: guide.title,
      subtext: "阅读记录写入失败；点击阅读",
    });
    notification().onClick!();
    await vi.waitFor(() => expect(steam.navigate).toHaveBeenCalledOnce());
    expect(steam.toast).toHaveBeenCalledOnce();
  });

  it("reports a failed notification click without rejecting the completed download", async () => {
    await downloads.start(identity);
    steam.navigate.mockImplementationOnce(() => {
      throw new Error("Steam 主窗口已关闭");
    });
    notification().onClick!();
    await vi.waitFor(() => expect(steam.toast).toHaveBeenCalledTimes(2));
    expect(steam.toast.mock.calls[1][0]).toMatchObject({
      title: "GRIP：打开失败",
      body: "Steam 主窗口已关闭",
    });
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("complete");
  });

  it("keeps the offline task complete if Steam's notification service throws", async () => {
    const error = new Error("Steam toast unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    steam.toast.mockImplementationOnce(() => {
      throw error;
    });
    await downloads.start(identity);
    expect(downloads.getSnapshot(identity.guideId)?.phase).toBe("complete");
    expect(steam.toast).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "[GRIP] Could not notify download completion",
      error,
    );
    expect(steam.navigate).not.toHaveBeenCalled();
  });
});
