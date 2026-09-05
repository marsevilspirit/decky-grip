// @vitest-environment happy-dom

import { act, createContext, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GuideDownloadButton,
  type GuideDownloadButtonProps,
} from "../../src/components/GuideDownloadButton";
import type { DownloadedGuide } from "../../src/reader/types";
import type { GuideDownloadStatus } from "../../src/backend";
import type { GuideIdentity } from "../../src/steam/guide-key";
import { GuideDownloadTasks } from "../../src/reader/download";

vi.mock("@decky/ui", () => ({
  DialogButton: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => createElement("button", { disabled, onClick }, children),
  Spinner: () => createElement("span"),
}));

const firstGuide: GuideIdentity = { appId: "1113000", guideId: "10" };
const secondGuide: GuideIdentity = { appId: "1113000", guideId: "20" };

function deferredGuide() {
  let resolve!: (guide: Pick<DownloadedGuide, "stale">) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Pick<DownloadedGuide, "stale">>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, reject, resolve };
}

describe("GuideDownloadButton", () => {
  let container: HTMLDivElement | null = null;
  let portalTarget: HTMLDivElement | null = null;
  let root: Root | null = null;

  const button = (): HTMLButtonElement | null =>
    portalTarget?.querySelector("button") ?? null;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    portalTarget?.remove();
    container = null;
    portalTarget = null;
    root = null;
  });

  it("shows a continuing task on remount and lets the user cancel it", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const downloads = new GuideDownloadTasks(
      async (_id, progress, nextSignal) => {
        signal = nextSignal;
        progress({ completed: 13, total: 61 });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    const work = downloads.start(firstGuide);
    await Promise.resolve();
    container = document.createElement("div");
    portalTarget = document.createElement("div");
    document.body.append(container, portalTarget);
    root = createRoot(container);
    const NavigationContext = createContext<unknown>(null);
    const getDownloadStatus = vi.fn(async (): Promise<GuideDownloadStatus> => ({
      state: "partial",
      completed: 13,
      total: 61,
    }));
    await act(async () =>
      root?.render(
        <GuideDownloadButton
          identity={firstGuide}
          downloads={downloads}
          getDownloadStatus={getDownloadStatus}
          openGuide={async () => {}}
          target={{
            element: portalTarget!,
            navigationNode: {},
            navigationProvider: NavigationContext,
          }}
        />,
      ),
    );
    expect(button()?.textContent).toBe("图片 13/61…");
    expect(getDownloadStatus).not.toHaveBeenCalled();
    await act(async () => portalTarget?.querySelectorAll("button")[1]?.click());
    expect(signal.aborted).toBe(true);
    expect(button()?.textContent).toBe("正在停止下载…");
    await act(async () => {
      finish();
      await work;
    });
    expect(button()?.textContent).toBe("继续下载");
    expect(portalTarget.querySelectorAll("button")).toHaveLength(1);
  });

  it("restores disk status, resumes partial downloads and isolates old A requests across A → B → A", async () => {
    const first = deferredGuide();
    const failed = deferredGuide();
    const stale = deferredGuide();
    const downloadGuide = vi
      .fn<ConstructorParameters<typeof GuideDownloadTasks>[0]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(stale.promise);
    const downloads = new GuideDownloadTasks(downloadGuide);
    const states = new Map<string, GuideDownloadStatus>();
    const missing: GuideDownloadStatus = {
      state: "missing",
      completed: 0,
      total: 0,
    };
    const complete: GuideDownloadStatus = {
      state: "complete",
      completed: 61,
      total: 61,
    };
    const getDownloadStatus = vi.fn(
      async (guideId: string) => states.get(guideId) ?? missing,
    );
    const openGuide = vi.fn(async () => undefined);
    const NavigationContext = createContext<unknown>(null);
    const navigationNode = {};

    container = document.createElement("div");
    portalTarget = document.createElement("div");
    document.body.append(container, portalTarget);
    root = createRoot(container);
    const render = async (identity: GuideIdentity | null, revision = 0) => {
      await act(async () => {
        root?.render(
          <GuideDownloadButton
            downloads={downloads}
            getDownloadStatus={getDownloadStatus}
            openGuide={openGuide}
            revision={revision}
            identity={identity}
            target={{
              element: portalTarget!,
              navigationNode,
              navigationProvider: NavigationContext,
            }}
          />,
        );
      });
    };

    await render(null);
    expect(container.querySelector("button")).toBeNull();
    expect(button()).toBeNull();

    await render(firstGuide);
    expect(button()?.parentElement).toBe(portalTarget);
    expect(button()?.textContent).toBe("下载到 GRIP");
    await act(async () => {
      button()?.click();
    });
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("下载中…");
    expect(button()?.querySelector('[data-grip-busy="true"]')).not.toBeNull();
    await act(async () => button()?.click());
    expect(downloadGuide).toHaveBeenCalledOnce();
    await act(async () => {
      downloadGuide.mock.calls[0][1]?.({ completed: 13, total: 61 });
    });
    expect(button()?.textContent).toBe("图片 13/61…");
    expect(button()?.disabled).toBe(true);

    await render(secondGuide);
    expect(button()?.disabled).toBe(false);
    await render(firstGuide);
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("图片 13/61…");
    await act(async () => button()?.click());
    expect(downloadGuide).toHaveBeenCalledOnce();
    await act(async () => {
      states.set(firstGuide.guideId, complete);
      first.resolve({ stale: false });
    });
    expect(button()?.textContent).toBe("本地阅读");
    await act(async () => button()?.click());
    expect(openGuide).toHaveBeenCalledWith(firstGuide);
    expect(downloadGuide).toHaveBeenCalledTimes(1);

    states.set(secondGuide.guideId, {
      state: "partial",
      completed: 13,
      total: 61,
    });
    await render(secondGuide);
    expect(button()?.textContent).toBe("补全下载");
    await act(async () => button()?.click());
    await act(async () => failed.reject(new Error("offline")));
    expect(button()?.textContent).toBe("重试下载");

    await act(async () => button()?.click());
    await act(async () => {
      states.set(secondGuide.guideId, complete);
      stale.resolve({ stale: true });
    });
    expect(button()?.textContent).toBe("本地阅读");

    await render(null);
    await render(secondGuide);
    expect(button()?.textContent).toBe("本地阅读");
    expect(downloadGuide).toHaveBeenCalledTimes(3);

    states.set(secondGuide.guideId, {
      state: "partial",
      completed: 0,
      total: 61,
    });
    await render(secondGuide, 1);
    expect(button()?.textContent).toBe("补全下载");
    states.delete(secondGuide.guideId);
    await render(secondGuide, 2);
    expect(button()?.textContent).toBe("下载到 GRIP");

    await render(null);
    expect(button()).toBeNull();
  });

  it("retries failed status checks and local opens with immediate duplicate protection", async () => {
    let finishCheck!: (status: GuideDownloadStatus) => void;
    let failOpen!: (error: unknown) => void;
    const getDownloadStatus = vi
      .fn<GuideDownloadButtonProps["getDownloadStatus"]>()
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCheck = resolve;
          }),
      )
      .mockResolvedValue({ state: "complete", completed: 1, total: 1 });
    const openGuide = vi
      .fn<GuideDownloadButtonProps["openGuide"]>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOpen = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const downloadGuide = vi.fn();
    const NavigationContext = createContext<unknown>(null);
    container = document.createElement("div");
    portalTarget = document.createElement("div");
    document.body.append(container, portalTarget);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <GuideDownloadButton
          downloads={new GuideDownloadTasks(downloadGuide)}
          getDownloadStatus={getDownloadStatus}
          identity={firstGuide}
          openGuide={openGuide}
          target={{
            element: portalTarget!,
            navigationNode: {},
            navigationProvider: NavigationContext,
          }}
        />,
      ),
    );
    expect(button()?.textContent).toBe("检查失败，重试");
    await act(async () => button()?.click());
    expect(button()?.textContent).toBe("检查下载…");
    expect(button()?.disabled).toBe(true);
    await act(async () =>
      finishCheck({ state: "complete", completed: 1, total: 1 }),
    );
    expect(button()?.textContent).toBe("本地阅读");
    await act(async () => {
      button()?.click();
      button()?.click();
    });
    expect(button()?.textContent).toBe("正在打开…");
    expect(button()?.disabled).toBe(true);
    expect(openGuide).toHaveBeenCalledTimes(1);
    await act(async () => failOpen(new Error("navigation failed")));
    expect(button()?.textContent).toBe("重试打开");
    await act(async () => button()?.click());
    expect(openGuide).toHaveBeenCalledTimes(2);
    expect(downloadGuide).not.toHaveBeenCalled();
  });
});
