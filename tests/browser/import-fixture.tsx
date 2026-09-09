import { useState } from "react";
import {
  ImportGuideModal,
  type ImportGuideDraft,
} from "../../src/components/ImportGuideModal";
import { GuideReaderPage } from "../../src/components/GuideReaderPage";
import {
  downloadOfflineGuide,
  GuideDownloadTasks,
} from "../../src/reader/download";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import { ReaderImageHydrator } from "../../src/reader/image-hydrator";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import { ReaderSessionCache } from "../../src/reader/session-cache";
import type { DownloadedGuide } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";
import { ReaderRoute } from "./decky-ui";

const imageUrls = [1, 2, 3].map(
  (number) => `https://images.steamusercontent.com/ugc/import/${number}.png`,
);
const imageCache = new Set<string>();
const staged = new Map<string, DownloadedGuide>();
let sequence = 0;
const gate = async (path: string) => {
  const response = await fetch(`/fixture/import/${path}`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
};
const publication = (): {
  identity: GuideIdentity;
  guide: DownloadedGuide;
} | null =>
  JSON.parse(localStorage.getItem("grip-browser:import-publication") ?? "null");
const record = (event: string) => {
  const events: string[] = JSON.parse(
    localStorage.getItem("grip-browser:import-events") ?? "[]",
  );
  localStorage.setItem(
    "grip-browser:import-events",
    JSON.stringify([...events, event]),
  );
};

// Only source extraction/disk/network are fixtures. The production transaction owns
// deduplication, three download workers, progress, cancellation, retry and publication.
const downloads = new GuideDownloadTasks(
  (identity, progress, signal, forceRefresh) =>
    downloadOfflineGuide(
      identity.guideId,
      forceRefresh,
      {
        prepareGuide: async (guideId) => {
          await gate("prepare");
          const guide: DownloadedGuide = {
            guideId,
            title: "手机导入的完整图文",
            author: "本地下载边界 fixture",
            sourceUrl: `https://www.xiaoheihe.cn/app/bbs/link/${guideId.slice(7)}`,
            fetchedAt: Date.now(),
            fromCache: true,
            stale: false,
            sections: [
              {
                id: "intro",
                title: "手机分享导入章节",
                html: `<p>只有全部图片保存成功，这个版本才能进入本地阅读器。</p>${[...imageUrls, imageUrls[0]].map((url, index) => `<img width="96" height="96" alt="导入图片 ${index + 1}" data-grip-image-url="${url}">`).join("")}`,
              },
            ],
          };
          const token = String(++sequence);
          staged.set(token, guide);
          record(`prepare:${token}`);
          return { token, guide };
        },
        downloadGuideImage: async (url) => {
          if (imageCache.has(url)) {
            record(`reuse:${url}`);
            return { saved: true };
          }
          await gate(`image/${imageUrls.indexOf(url) + 1}`);
          imageCache.add(url);
          record(`image:${url}`);
          return { saved: true };
        },
        commitGuide: async (_guideId, token) => {
          await gate("commit");
          const guide = staged.get(token);
          if (!guide || !imageUrls.every((url) => imageCache.has(url)))
            throw new Error("Cannot publish an incomplete fixture download");
          localStorage.setItem(
            "grip-browser:import-publication",
            JSON.stringify({ identity, guide }),
          );
          record(`commit:${token}`);
          staged.delete(token);
          return guide;
        },
        discardGuide: async (_guideId, token) => {
          await gate("discard");
          record(`discard:${token}`);
          return staged.delete(token);
        },
      },
      progress,
      signal,
    ),
);
const loadPublished = async () => {
  const stored = publication();
  if (!stored) throw new Error("尚未发布完整离线版本");
  return stored.guide;
};
const cache = new ReaderSessionCache({
  getCachedGuide: async () => publication()?.guide ?? null,
  getGuide: loadPublished,
  getReaderPosition: async () => null,
  saveReaderPosition: async (
    _key,
    scrollTop,
    sectionId,
    anchorText,
    anchorOffset,
  ) => ({
    scrollTop,
    sectionId,
    anchorText,
    anchorOffset,
    updatedAt: Date.now(),
  }),
});
const imageHydrator = new ReaderImageHydrator(async (url) => {
  if (!imageCache.has(url)) throw new Error("导入图片未下载");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  return {
    mimeType: "image/png",
    base64: canvas.toDataURL("image/png").split(",")[1],
    width: 96,
    height: 96,
    fromCache: true,
  };
});
const imageCacheControl = new ReaderImageCacheControl();
const performance = new ReaderPerformanceTracker();
let importDraft: ImportGuideDraft | undefined;

export function ImportFixture() {
  const [modal, setModal] = useState(true);
  const [route, setRoute] = useState<GuideIdentity | null>(null);
  return (
    <>
      {route && (
        <ReaderRoute.Provider value={route}>
          <GuideReaderPage
            cache={cache}
            downloads={downloads}
            imageHydrator={imageHydrator}
            imageCacheControl={imageCacheControl}
            performance={performance}
            loadGuideLibrary={async () => []}
            onClose={() => setRoute(null)}
            onSwitchGuide={async (identity) => setRoute(identity)}
            onRepairPositions={async () => ""}
            onRemoveOffline={async () => ({ filesRemoved: 0, bytesRemoved: 0 })}
          />
        </ReaderRoute.Provider>
      )}
      {!route && <button onClick={() => setModal(true)}>导入公开攻略</button>}
      {modal && (
        <ImportGuideModal
          games={[
            { data: "1113000", label: "女神异闻录4 黄金版" },
            { data: "1868140", label: "潜水员戴夫" },
          ]}
          downloads={downloads}
          initialDraft={importDraft}
          onDraftChange={(draft) => {
            importDraft = draft;
          }}
          onOpen={async (identity) => {
            await loadPublished();
            setRoute(identity);
          }}
          closeModal={() => setModal(false)}
        />
      )}
    </>
  );
}
