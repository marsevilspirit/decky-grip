// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuideDownloadButton } from "../../src/components/GuideDownloadButton";
import type { DownloadedGuide } from "../../src/reader/types";
import { RuntimeStatusStore } from "../../src/runtime-status";
import type { GuideIdentity } from "../../src/steam/guide-key";

vi.mock("@decky/ui", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => createElement("button", { disabled, onClick }, children),
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
  let root: Root | null = null;

  const button = (): HTMLButtonElement | null =>
    container?.querySelector("button") ?? null;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("shows download states and ignores a request from the previous guide", async () => {
    const status = new RuntimeStatusStore("1113000");
    const first = deferredGuide();
    const retry = deferredGuide();
    const stale = deferredGuide();
    const cached = deferredGuide();
    const downloadGuide = vi
      .fn<
        (identity: GuideIdentity) => Promise<Pick<DownloadedGuide, "stale">>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(cached.promise);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <GuideDownloadButton downloadGuide={downloadGuide} status={status} />,
      );
    });
    expect(button()).toBeNull();

    await act(async () => status.update({ activeGuide: firstGuide }));
    expect(button()?.textContent).toBe("下载正文到 GRIP");
    await act(async () => button()?.click());
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("正在下载正文…");
    await act(async () => button()?.click());
    expect(downloadGuide).toHaveBeenCalledOnce();

    await act(async () => status.update({ activeGuide: secondGuide }));
    expect(button()?.disabled).toBe(false);
    expect(button()?.textContent).toBe("下载正文到 GRIP");
    await act(async () => first.resolve({ stale: false }));
    expect(button()?.textContent).toBe("下载正文到 GRIP");
    await act(async () => status.update({ activeGuide: firstGuide }));
    expect(button()?.disabled).toBe(false);
    expect(button()?.textContent).toBe("下载正文到 GRIP");
    await act(async () => status.update({ activeGuide: secondGuide }));

    await act(async () => button()?.click());
    await act(async () => retry.reject(new Error("offline")));
    expect(button()?.textContent).toBe("下载失败，点击重试");

    await act(async () => button()?.click());
    await act(async () => stale.resolve({ stale: true }));
    expect(button()?.textContent).toBe("已缓存到 GRIP（旧版）");

    await act(async () => button()?.click());
    await act(async () => cached.resolve({ stale: false }));
    expect(button()?.textContent).toBe("正文已缓存到 GRIP");
    expect(downloadGuide).toHaveBeenCalledTimes(4);

    await act(async () => status.update({ activeGuide: null }));
    expect(button()).toBeNull();
  });
});
