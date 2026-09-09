import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { GuideLibraryEntry } from "../../src/backend";
import { GuideReaderPage } from "../../src/components/GuideReaderPage";
import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";
import { ReaderImageHydrator } from "../../src/reader/image-hydrator";
import { ReaderPerformanceTracker } from "../../src/reader/performance";
import { ReaderSessionCache } from "../../src/reader/session-cache";
import type { DownloadedGuide, ReaderPosition } from "../../src/reader/types";
import type { GuideIdentity } from "../../src/steam/guide-key";
import { ReaderRoute } from "./decky-ui";
import { ImportFixture } from "./import-fixture";

const identity = { appId: "1113000", guideId: "3414883877" };
const scenario = new URLSearchParams(location.search).get("scenario");
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
const removedGuides = new Set<string>(
  JSON.parse(localStorage.getItem("grip-browser:removed-guides") ?? "[]"),
);
const guides = new Map(
  entries.map((entry, guideIndex) => [
    entry.guideId,
    guideIndex === 0 && scenario !== "journey" && scenario !== "scroll"
      ? guide
      : {
          ...guide,
          guideId: entry.guideId,
          title: entry.cache!.title,
          sourceUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${entry.guideId}`,
          sections: Array.from(
            { length: scenario === "scroll" ? 20 : 18 },
            (_, chapter) => ({
              id: String(chapter + 1),
              title: `指南 ${guideIndex + 1} · 第 ${chapter + 1} 章`,
              html:
                scenario === "scroll"
                  ? Array.from(
                      { length: 30 },
                      (_, image) =>
                        `<p>第 ${chapter + 1} 章，图片 ${image + 1}</p><img alt="图片-${chapter + 1}-${image + 1}" width="96" height="96" data-grip-image-url="https://images.steamusercontent.com/ugc/fixture/table.png">`,
                    ).join("")
                  : Array.from(
                      { length: 8 },
                      (_, paragraph) =>
                        `<p>指南 ${guideIndex + 1}，章节 ${chapter + 1}，段落 ${paragraph + 1}。这是独立的本地正文，用真实文字锚点验证切换、关闭和重新打开后仍然停在原来的阅读位置。</p>`,
                    ).join(""),
            }),
          ),
        },
  ]),
);
for (const guideId of removedGuides) guides.delete(guideId);
const findGuide = (guideId: string) => {
  const result = guides.get(guideId);
  if (!result) throw new Error("本地没有该指南");
  return result;
};
const backendGate = async (path: string, method = "GET") => {
  const response = await fetch(`/fixture/${path}`, { method });
  if (!response.ok) throw new Error(await response.text());
};
const cache = new ReaderSessionCache({
  getCachedGuide: async (guideId) => guides.get(guideId) ?? null,
  getGuide: async ({ guideId }) => {
    await backendGate(`guide/${guideId}`);
    return findGuide(guideId);
  },
  getReaderPosition: async (key) =>
    JSON.parse(localStorage.getItem(`grip-browser:position:${key}`) ?? "null"),
  saveReaderPosition: async (
    key,
    scrollTop,
    sectionId,
    anchorText,
    anchorOffset,
  ) => {
    await backendGate(`position/${key}`, "PUT");
    const position: ReaderPosition = {
      scrollTop,
      sectionId,
      anchorText,
      anchorOffset,
      updatedAt: Date.now(),
    };
    localStorage.setItem(
      `grip-browser:position:${key}`,
      JSON.stringify(position),
    );
    return position;
  },
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
const imageCacheControl = new ReaderImageCacheControl();
const performance = new ReaderPerformanceTracker();
const loadGuideLibrary = async () =>
  entries.map((entry) => ({
    ...entry,
    cache: guides.has(entry.guideId) ? entry.cache : null,
  }));
const removeOfflineGuide = async (guideId: string) => {
  try {
    await backendGate(`remove/${guideId}`, "DELETE");
    const removed = guides.delete(guideId);
    removedGuides.add(guideId);
    localStorage.setItem(
      "grip-browser:removed-guides",
      JSON.stringify([...removedGuides]),
    );
    return { filesRemoved: removed ? 1 : 0, bytesRemoved: removed ? 100 : 0 };
  } finally {
    cache.clear();
  }
};

function Fixture() {
  const [route, setRoute] = useState<GuideIdentity>(() => ({
    ...identity,
    guideId:
      new URLSearchParams(location.search).get("guideId") ?? identity.guideId,
  }));
  const [open, setOpen] = useState(true);
  return (
    <ReaderRoute.Provider value={route}>
      <div data-fixture-route={route.guideId}>
        {open ? (
          <GuideReaderPage
            key={`${route.appId}:${route.guideId}`}
            cache={cache}
            imageHydrator={imageHydrator}
            imageCacheControl={imageCacheControl}
            loadGuideLibrary={loadGuideLibrary}
            onClose={() => setOpen(false)}
            onRepairPositions={async () => ""}
            onRemoveOffline={removeOfflineGuide}
            onSwitchGuide={async (target) => {
              const url = new URL(location.href);
              url.searchParams.set("guideId", target.guideId);
              history.replaceState(null, "", url);
              setRoute(target);
            }}
            performance={performance}
          />
        ) : (
          <main aria-label="本地游戏占位页" style={{ padding: 48 }}>
            <h1>阅读器已关闭</h1>
            <button autoFocus onClick={() => setOpen(true)}>
              继续阅读
            </button>
          </main>
        )}
      </div>
    </ReaderRoute.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  scenario === "import" ? <ImportFixture /> : <Fixture />,
);
