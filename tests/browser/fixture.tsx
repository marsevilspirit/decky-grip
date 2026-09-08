import { createRoot } from "react-dom/client";
import type { GuideLibraryEntry } from "../../src/backend";
import { GuideReaderPage } from "../../src/components/GuideReaderPage";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import { ReaderImageHydrator } from "../../src/reader/image-hydrator";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import { ReaderSessionCache } from "../../src/reader/session-cache";
import type { DownloadedGuide } from "../../src/reader/types";

const identity = { appId: "1113000", guideId: "3414883877" };
const longToken = "WideTableCellWithoutAnyBreak".repeat(8);
const tableImage =
  '<img alt="表格中的离线图片" data-grip-image-url="https://images.steamusercontent.com/ugc/fixture/table.png">';
const cells = Array.from(
  { length: 10 },
  (_, index) =>
    `<td>${index === 0 ? tableImage : ""}${index}: ${longToken}</td>`,
).join("");
const steamCells = Array.from(
  { length: 10 },
  (_, index) =>
    `<div class="bb_table_td">${index === 0 ? tableImage : ""}${index}: ${longToken}</div>`,
).join("");
const guide: DownloadedGuide = {
  guideId: identity.guideId,
  title: "真实浏览器布局验收指南",
  author: "GRIP local fixture",
  sourceUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${identity.guideId}`,
  fetchedAt: 1,
  fromCache: true,
  stale: false,
  sections: Array.from({ length: 18 }, (_, index) => ({
    id: String(index + 1),
    title: `第 ${index + 1} 章：长标题与离线正文排版`,
    html:
      index === 0
        ? `<p>原生 table 与 Steam div 表格都必须适应正文宽度。</p><table><tbody><tr>${cells}</tr></tbody></table><div class="bb_table"><div class="bb_table_tr">${steamCells}</div></div>`
        : index === 4
          ? '<p>下载完成前保留占位。</p><img alt="延迟解码的离线长图" data-grip-image-url="https://images.steamusercontent.com/ugc/fixture/delayed.png"><p data-fixture-hit>离线图片后的精确命中，图片解码后仍然可见。</p>'
          : Array.from(
              { length: 6 },
              (_, paragraph) =>
                `<p>章节 ${index + 1}，段落 ${paragraph + 1}。用于验证正文位置、章节跳转以及目录开关时保持稳定的真实排版。</p>`,
            ).join(""),
  })),
};
const entries: GuideLibraryEntry[] = Array.from({ length: 20 }, (_, index) => ({
  ...identity,
  guideId: index === 0 ? identity.guideId : String(3414883877 + index),
  updatedAt: 20 - index,
  cache: {
    title: `第 ${index + 1} 篇 · 长指南标题：完整剧情流程、装备与全收集路线`,
    author: "本地作者",
    fetchedAt: 1,
    sectionTitle: "上次阅读的章节标题也应完整显示",
    stale: false,
  },
}));
const cache = new ReaderSessionCache({
  getCachedGuide: async () => guide,
  getGuide: async () => guide,
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
  // Tests gate only this backend response; the production Blob path and browser PNG decode stay real.
  const delayed = url.endsWith("/delayed.png");
  if (delayed) await fetch("/image-ready");
  const canvas = document.createElement("canvas");
  canvas.width = delayed ? 900 : 96;
  canvas.height = delayed ? 1600 : 96;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#214561";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#72d5ff";
  context.font = "40px sans-serif";
  context.fillText("Offline image: actual PNG decode", 30, 80);
  return {
    mimeType: "image/png",
    base64: canvas.toDataURL("image/png").split(",")[1],
    width: canvas.width,
    height: canvas.height,
    fromCache: true,
  };
});
await cache.load(identity);
createRoot(document.getElementById("root")!).render(
  <GuideReaderPage
    cache={cache}
    imageHydrator={imageHydrator}
    imageCacheControl={new ReaderImageCacheControl()}
    loadGuideLibrary={async () => entries}
    onClose={() => undefined}
    onRepairPositions={async () => ""}
    onRemoveOffline={async () => ({ filesRemoved: 1, bytesRemoved: 100 })}
    onSwitchGuide={async () => undefined}
    performance={new ReaderPerformanceTracker()}
  />,
);
