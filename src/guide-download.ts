import {
  cancelHeyboxCapture,
  captureHeybox,
  commitGuide,
  commitImportedGuide,
  discardGuide,
  downloadGuideImage,
  prepareGuide,
  prepareImportedGuide,
} from "./backend";
import { renderInSteamBrowser } from "./steam/import-browser";
import {
  downloadOfflineGuide,
  type GuideImageDownloadProgress,
} from "./reader/download";
import { isHeyboxGuideId, type GuideIdentity } from "./steam/guide-key";

/** Choose the source transport; both sources use the same complete-offline transaction. */
export function downloadGuide(
  identity: GuideIdentity,
  onProgress?: (progress: GuideImageDownloadProgress) => void,
  signal?: AbortSignal,
  forceRefresh = false,
) {
  const imported = isHeyboxGuideId(identity.guideId);
  return downloadOfflineGuide(
    identity.guideId,
    forceRefresh,
    {
      prepareGuide: imported
        ? async () => {
            const sourceUrl = `https://www.xiaoheihe.cn/app/bbs/link/${identity.guideId.slice(7)}`;
            const rendered = await renderInSteamBrowser(
              sourceUrl,
              captureHeybox,
              signal,
              cancelHeyboxCapture,
            );
            signal?.throwIfAborted();
            return prepareImportedGuide(rendered);
          }
        : prepareGuide,
      commitGuide: imported
        ? (guideId, token) =>
            commitImportedGuide(guideId, token, identity.appId)
        : commitGuide,
      discardGuide,
      downloadGuideImage,
    },
    onProgress,
    signal,
  );
}
