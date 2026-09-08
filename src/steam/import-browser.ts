import type { RenderedHeyboxGuide } from "../import/heybox";
import { parseHeyboxUrl } from "../import/heybox";

/** Own one disposable CEF page. Never attach to a user's existing browser tab. */
export async function renderInSteamBrowser(
  sourceUrl: string,
  capture: (sourceUrl: string, marker: string) => Promise<RenderedHeyboxGuide>,
  signal?: AbortSignal,
  cancelCapture?: (marker: string) => Promise<void>,
): Promise<RenderedHeyboxGuide> {
  signal?.throwIfAborted();
  const canonical = parseHeyboxUrl(sourceUrl).sourceUrl;
  const browser = globalThis.SteamClient?.BrowserView;
  if (!browser?.Create || !browser.Destroy) {
    throw new Error("Steam 浏览器尚未就绪，请回到游戏模式后重试导入");
  }
  const marker = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const url = `${canonical}#grip-import-${marker}`;
  const view = browser.Create({
    strInitialURL: "about:blank",
    bOnlyAllowTrustedPopups: true,
  });
  let destroyed = false;
  let guardNavigation: ((next: string) => void) | undefined;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      if (guardNavigation) view.off("start-request", guardNavigation);
    } catch (error) {
      console.warn(
        "[GRIP] Could not remove the browser navigation guard",
        error,
      );
    }
    try {
      browser.Destroy(view);
    } catch (error) {
      console.warn("[GRIP] Could not close the temporary browser page", error);
    }
  };
  let abortCapture: (() => void) | undefined;
  try {
    view.SetBounds(0, 0, 1280, 800);
    view.SetVisible(false);
    view.SetBlockedProtocols("steam;file;javascript;data;intent;heiheybox");
    const guide = await new Promise<RenderedHeyboxGuide>((resolve, reject) => {
      let capturing = false;
      const rejectCapture = (reason: unknown) => {
        if (destroyed) return;
        destroy();
        reject(reason);
        if (capturing && cancelCapture)
          void Promise.resolve()
            .then(() => cancelCapture(marker))
            .catch((error: unknown) =>
              console.warn("[GRIP] Could not cancel browser capture", error),
            );
      };
      guardNavigation = (next) => {
        if (next !== url && next !== "about:blank")
          rejectCapture(
            new Error("导入页面发生跳转，请重新导入公开的小黑盒文章"),
          );
      };
      abortCapture = () =>
        rejectCapture(
          signal?.reason ?? new DOMException("已取消导入", "AbortError"),
        );
      view.on("start-request", guardNavigation);
      signal?.addEventListener("abort", abortCapture, { once: true });
      signal?.throwIfAborted();
      view.LoadURL(url);
      if (destroyed) return;
      capturing = true;
      capture(canonical, marker).then(resolve, reject);
    });
    signal?.throwIfAborted();
    if (destroyed)
      throw new Error("导入页面发生跳转，请重新导入公开的小黑盒文章");
    return guide;
  } finally {
    if (abortCapture) signal?.removeEventListener("abort", abortCapture);
    destroy();
  }
}
