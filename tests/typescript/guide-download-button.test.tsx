// @vitest-environment happy-dom

import { act, createContext, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GuideDownloadButton,
  type GuideDownloadButtonProps,
} from "../../src/components/GuideDownloadButton";
import type { DownloadedGuide } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";

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

  it("portals download states without leaking an old A request into A → B → A", async () => {
    const first = deferredGuide();
    const second = deferredGuide();
    const failed = deferredGuide();
    const stale = deferredGuide();
    const cached = deferredGuide();
    const downloadGuide = vi
      .fn<GuideDownloadButtonProps["downloadGuide"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(cached.promise);
    const NavigationContext = createContext<unknown>(null);
    const navigationNode = {};

    container = document.createElement("div");
    portalTarget = document.createElement("div");
    document.body.append(container, portalTarget);
    root = createRoot(container);
    const render = async (identity: GuideIdentity | null) => {
      await act(async () => {
        root?.render(
          <GuideDownloadButton
            downloadGuide={downloadGuide}
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
    expect(button()?.disabled).toBe(false);
    await act(async () => button()?.click());
    await act(async () => first.resolve({ stale: true }));
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("下载中…");
    await act(async () => second.resolve({ stale: false }));
    expect(button()?.textContent).toBe("已下载");

    await render(secondGuide);
    await act(async () => button()?.click());
    await act(async () => failed.reject(new Error("offline")));
    expect(button()?.textContent).toBe("重试下载");

    await act(async () => button()?.click());
    await act(async () => stale.resolve({ stale: true }));
    expect(button()?.textContent).toBe("已下载（旧版）");

    await act(async () => button()?.click());
    await act(async () => cached.resolve({ stale: false }));
    expect(button()?.textContent).toBe("已下载");
    expect(downloadGuide).toHaveBeenCalledTimes(5);

    await render(null);
    expect(button()).toBeNull();
  });
});
