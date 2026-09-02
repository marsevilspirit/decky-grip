import { describe, expect, it } from "vitest";

import {
  captureReaderPosition,
  closestAnchorScrollTop,
  normalizeAnchorText,
  ReaderAnchorIndex,
  restoreReaderPosition,
} from "../../src/reader/anchor";
import {
  chooseObservedGuide,
  filterGuideLibraryEntries,
  guideCacheAction,
  guideChoicesForReader,
  guideCacheRefreshFellBack,
  RecentGuideIndex,
  resolveGuideForReaderOpen,
} from "../../src/reader/recent-guide";
import { RuntimeStatusStore } from "../../src/runtime-status";
import { shortSectionTitle } from "../../src/reader/toc-title";

interface FakeAnchorText extends Partial<Text> {
  contentBottom: number;
  contentTop: number;
  textContent: string;
}

interface FakeAnchorRoot extends Partial<HTMLElement> {
  nodes: FakeAnchorText[];
}

function makeAnchorDom() {
  let treeWalkerCalls = 0;
  let scroller: HTMLElement;
  const sections: HTMLElement[] = [];
  const document = {
    defaultView: { NodeFilter: { SHOW_TEXT: 4 } },
    createTreeWalker: (root: FakeAnchorRoot) => {
      treeWalkerCalls += 1;
      let index = 0;
      return {
        nextNode: () => root.nodes[index++] ?? null,
      };
    },
    createRange: () => {
      let selected: FakeAnchorText;
      return {
        selectNodeContents: (node: FakeAnchorText) => {
          selected = node;
        },
        getBoundingClientRect: () =>
          ({
            bottom: selected.contentBottom - scroller.scrollTop,
            height: selected.contentBottom - selected.contentTop,
            left: 0,
            right: 500,
            top: selected.contentTop - scroller.scrollTop,
            width: 500,
          }) as DOMRect,
      };
    },
  };
  const content = {
    dataset: {},
    nodes: [],
    ownerDocument: document,
    querySelectorAll: () => sections,
  } as unknown as HTMLElement;
  scroller = {
    clientHeight: 100,
    getBoundingClientRect: () =>
      ({ bottom: 100, height: 100, top: 0 }) as DOMRect,
    scrollHeight: 1_000,
    scrollTop: 0,
  } as unknown as HTMLElement;

  const addSection = (
    id: string,
    nodes: Array<{ bottom: number; text: string; top: number }>,
  ) => {
    const section = {
      dataset: { guideSectionId: id },
      nodes: [] as FakeAnchorText[],
      ownerDocument: document,
    } as unknown as HTMLElement & FakeAnchorRoot;
    section.nodes = nodes.map(
      ({ bottom, text, top }) =>
        ({
          contentBottom: bottom,
          contentTop: top,
          nodeType: 3,
          ownerDocument: document as unknown as Document,
          parentElement: section,
          textContent: text,
        }) as unknown as FakeAnchorText,
    );
    sections.push(section);
  };

  return {
    addSection,
    content,
    scroller,
    treeWalkerCalls: () => treeWalkerCalls,
  };
}

describe("GRIP Reader helpers", () => {
  it("normalizes visible text without changing its words", () => {
    expect(normalizeAnchorText("  4/23\n  去河堤  下方 ")).toBe(
      "4/23 去河堤 下方",
    );
  });

  it("restores a repeated text anchor nearest the saved pixel fallback", () => {
    expect(closestAnchorScrollTop([220, 4_080, 8_100], 4_040)).toBe(4_080);
    expect(closestAnchorScrollTop([], 4_040)).toBeNull();
  });

  it("falls back to the same text globally when its saved section changed", () => {
    const dom = makeAnchorDom();
    dom.addSection("old", [{ bottom: 40, text: "其他段落", top: 20 }]);
    dom.addSection("new", [
      { bottom: 440, text: "移动后的目标段落", top: 400 },
    ]);
    const index = new ReaderAnchorIndex(dom.content);

    restoreReaderPosition(
      dom.scroller,
      dom.content,
      {
        anchorOffset: 20,
        anchorText: "移动后的目标段落",
        scrollTop: 100,
        sectionId: "old",
        updatedAt: 1,
      },
      index,
    );

    expect(dom.scroller.scrollTop).toBe(380);
  });

  it("indexes each mounted section once across repeated saves and restores", () => {
    const dom = makeAnchorDom();
    dom.addSection("10", [
      { bottom: 24, text: "第一段", top: 4 },
      { bottom: 224, text: "目标段落", top: 200 },
    ]);
    const index = new ReaderAnchorIndex(dom.content);

    expect(index.size).toBe(2);
    expect(dom.treeWalkerCalls()).toBe(1);
    expect(
      captureReaderPosition(dom.scroller, dom.content, index),
    ).toMatchObject({ anchorText: "第一段", sectionId: "10" });
    expect(
      captureReaderPosition(dom.scroller, dom.content, index),
    ).toMatchObject({ anchorText: "第一段", sectionId: "10" });
    restoreReaderPosition(
      dom.scroller,
      dom.content,
      {
        anchorOffset: 20,
        anchorText: "目标段落",
        scrollTop: 180,
        sectionId: "10",
        updatedAt: 1,
      },
      index,
    );
    expect(dom.treeWalkerCalls()).toBe(1);

    dom.addSection("11", [{ bottom: 424, text: "后来挂载", top: 400 }]);
    expect(index.refresh()).toBe(1);
    expect(index.size).toBe(3);
    expect(dom.treeWalkerCalls()).toBe(2);
    expect(index.refresh()).toBe(0);
    expect(dom.treeWalkerCalls()).toBe(2);
  });

  it("anchors a text-free viewport to nearby text across layout changes", () => {
    const source = makeAnchorDom();
    source.addSection("10", [
      { bottom: 20, text: "图片上方", top: 0 },
      { bottom: 420, text: "图片下方", top: 400 },
    ]);
    source.scroller.scrollTop = 200;

    const captured = captureReaderPosition(source.scroller, source.content);

    expect(captured).toMatchObject({
      anchorOffset: 200,
      anchorText: "图片下方",
      scrollTop: 200,
      sectionId: "10",
    });

    const restored = makeAnchorDom();
    restored.addSection("10", [
      { bottom: 20, text: "图片上方", top: 0 },
      { bottom: 520, text: "图片下方", top: 500 },
    ]);
    restoreReaderPosition(restored.scroller, restored.content, {
      ...captured,
      updatedAt: 1,
    });

    expect(restored.scroller.scrollTop).toBe(300);
  });

  it("replaces persisted recent-guide seeds after a store repair", () => {
    const index = new RecentGuideIndex();
    index.seed([
      {
        identity: { appId: "1113000", guideId: "10" },
        updatedAt: 100,
      },
    ]);
    index.remember({ appId: "222", guideId: "20" });

    index.seed([]);

    expect(index.find("1113000")).toBeNull();
    expect(index.find("222")).toEqual({ appId: "222", guideId: "20" });
  });

  it("merges newer reader history without dropping other app seeds", () => {
    const index = new RecentGuideIndex();
    index.seed([
      {
        identity: { appId: "1113000", guideId: "10" },
        updatedAt: 100,
      },
      {
        identity: { appId: "222", guideId: "20" },
        updatedAt: 200,
      },
    ]);

    index.merge([
      {
        identity: { appId: "1113000", guideId: "11" },
        updatedAt: 300,
      },
    ]);

    expect(index.find("1113000")).toEqual({
      appId: "1113000",
      guideId: "11",
    });
    expect(index.find("222")).toEqual({ appId: "222", guideId: "20" });
    expect(index.find()).toEqual({ appId: "1113000", guideId: "11" });
  });

  it("never selects another game's observed guide while a game is running", () => {
    const otherGame = { appId: "222", guideId: "20" };
    const runningGame = { appId: "1113000", guideId: "11" };

    expect(chooseObservedGuide(otherGame, runningGame, "1113000")).toEqual(
      runningGame,
    );
    expect(chooseObservedGuide(otherGame, null, "1113000")).toBeNull();
    expect(chooseObservedGuide(otherGame, null)).toEqual(otherGame);
  });

  it("opens a known guide without waiting for pending recent-guide history", async () => {
    const identity = { appId: "1113000", guideId: "11" };
    const pendingHistory = new Promise<void>(() => undefined);

    for (const requestedIdentity of [identity, undefined]) {
      let opened: typeof identity | null | undefined;
      void resolveGuideForReaderOpen(
        requestedIdentity,
        () => identity,
        pendingHistory,
      ).then((resolved) => {
        opened = resolved;
      });
      await Promise.resolve();
      expect(opened).toEqual(identity);
    }
  });

  it("retries guide resolution after recent-guide history is ready", async () => {
    const identity = { appId: "1113000", guideId: "11" };
    let resolveHistory!: () => void;
    const pendingHistory = new Promise<void>((resolve) => {
      resolveHistory = resolve;
    });
    let resolveCalls = 0;
    const resolveIdentity = () => (++resolveCalls === 1 ? null : identity);
    const resolved = resolveGuideForReaderOpen(
      undefined,
      resolveIdentity,
      pendingHistory,
    );

    expect(resolveCalls).toBe(1);
    resolveHistory();
    await expect(resolved).resolves.toEqual(identity);
    expect(resolveCalls).toBe(2);
  });

  it("keeps runtime recent guides partitioned when switching A to B and back", () => {
    const recentGuides = new RecentGuideIndex();
    recentGuides.seed([
      {
        identity: { appId: "1113000", guideId: "10" },
        updatedAt: 100,
      },
      {
        identity: { appId: "222", guideId: "20" },
        updatedAt: 200,
      },
    ]);

    const runtimeGuideA = { appId: "1113000", guideId: "11" };
    const runtimeGuideB = { appId: "222", guideId: "21" };
    recentGuides.remember(runtimeGuideA);
    recentGuides.remember(runtimeGuideB);

    expect(recentGuides.find("1113000")).toEqual(runtimeGuideA);
    expect(recentGuides.find("222")).toEqual(runtimeGuideB);
    expect(recentGuides.find()).toEqual(runtimeGuideB);
    expect(
      chooseObservedGuide(null, recentGuides.find("1113000"), "1113000"),
    ).toEqual(runtimeGuideA);
  });

  it("tracks A to B library switches and ignores duplicate app events", () => {
    const status = new RuntimeStatusStore("1113000");
    let notifications = 0;
    const unsubscribe = status.subscribe(() => {
      notifications += 1;
    });

    status.setGuideLibraryAppId("222");
    status.setGuideLibraryAppId("222");
    status.refreshGuideLibrary();

    expect(status.getSnapshot().guideLibraryAppId).toBe("222");
    expect(status.getSnapshot().guideLibraryRevision).toBe(2);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("filters the bounded guide library without changing backend order", () => {
    const entries = [
      {
        appId: "1113000",
        guideId: "10",
        updatedAt: 200,
        favorite: true,
        cache: {
          author: "Alice",
          fetchedAt: 1,
          sectionTitle: "四月",
          stale: false,
          title: "完整攻略",
        },
      },
      {
        appId: "222",
        guideId: "20",
        updatedAt: 100,
        favorite: false,
        cache: null,
      },
    ];

    expect(filterGuideLibraryEntries(entries, "ALICE", false)).toEqual([
      entries[0],
    ]);
    expect(filterGuideLibraryEntries(entries, "20", false)).toEqual([
      entries[1],
    ]);
    expect(filterGuideLibraryEntries(entries, "", true)).toEqual([entries[0]]);
    expect(filterGuideLibraryEntries(entries, "", false)).toEqual(entries);
  });

  it("keeps reader guide choices inside one app and puts the current guide first", () => {
    const current = {
      appId: "1113000",
      guideId: "10",
      updatedAt: 300,
      favorite: false,
      cache: {
        author: "Alice",
        fetchedAt: 1,
        sectionTitle: "四月",
        stale: false,
        title: "当前攻略",
      },
    };
    const sameGame = {
      appId: "1113000",
      guideId: "11",
      updatedAt: 200,
      favorite: true,
      cache: null,
    };
    const otherGame = {
      appId: "222",
      guideId: "20",
      updatedAt: 400,
      favorite: true,
      cache: null,
    };

    expect(guideChoicesForReader([sameGame, otherGame], current)).toEqual([
      current,
      sameGame,
    ]);
    expect(
      guideChoicesForReader(
        [{ ...current, favorite: true, cache: null }, sameGame, otherGame],
        current,
      ),
    ).toEqual([{ ...current, favorite: true }, sameGame]);
  });

  it("chooses explicit cache actions and identifies an offline refresh fallback", () => {
    const missing = {
      appId: "1",
      guideId: "10",
      updatedAt: 1,
      favorite: false,
      cache: null,
    };
    const fresh = {
      ...missing,
      cache: {
        author: "author",
        fetchedAt: 1,
        sectionTitle: null,
        stale: false,
        title: "title",
      },
    };
    const stale = {
      ...fresh,
      cache: { ...fresh.cache, stale: true },
    };

    expect(guideCacheAction(missing)).toBe("download");
    expect(guideCacheAction(fresh)).toBeNull();
    expect(guideCacheAction(stale)).toBe("refresh");
    expect(guideCacheRefreshFellBack("refresh", { stale: true })).toBe(true);
    expect(guideCacheRefreshFellBack("refresh", { stale: false })).toBe(false);
    expect(guideCacheRefreshFellBack("download", { stale: true })).toBe(false);
  });

  it("keeps short month headings and limits long headings to four characters", () => {
    expect(shortSectionTitle("四月")).toBe("四月");
    expect(shortSectionTitle("十一月")).toBe("十一月");
    expect(shortSectionTitle("十二月二十四日以后")).toBe("十二月二");
  });

  it("removes the shared appendix prefix before shortening headings", () => {
    expect(shortSectionTitle("附录：女皇社群需求推荐")).toBe("女皇社群");
    expect(shortSectionTitle("附录：人格面具合体表")).toBe("人格面具");
    expect(shortSectionTitle("附录：隐藏人格面具一览")).toBe("隐藏人格");
  });
});
