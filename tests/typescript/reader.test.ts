import { describe, expect, it } from "vitest";

import {
  captureReaderPosition,
  closestAnchorScrollTop,
  normalizeAnchorText,
  ReaderAnchorIndex,
  restoreReaderPosition,
} from "../../src/reader/anchor";
import {
  initialRenderedSectionCount,
  nextRenderedSectionCount,
  SECTION_RENDER_BATCH,
} from "../../src/reader/progressive-render";
import {
  chooseObservedGuide,
  findMostRecentGuide,
  RecentGuideIndex,
} from "../../src/reader/recent-guide";
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

  it("reveals a huge guide in deterministic bounded section batches", () => {
    const counts = [initialRenderedSectionCount(512)];
    while (counts[counts.length - 1] < 512) {
      counts.push(nextRenderedSectionCount(counts[counts.length - 1], 512));
    }

    expect(counts[0]).toBe(1);
    expect(counts[counts.length - 1]).toBe(512);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index] - counts[index - 1]).toBeLessThanOrEqual(
        SECTION_RENDER_BATCH,
      );
      expect(counts[index]).toBeGreaterThan(counts[index - 1]);
    }
    expect(initialRenderedSectionCount(0)).toBe(0);
    expect(initialRenderedSectionCount(3)).toBe(1);
    expect([
      initialRenderedSectionCount(20),
      nextRenderedSectionCount(1, 20),
      nextRenderedSectionCount(9, 20),
      nextRenderedSectionCount(17, 20),
    ]).toEqual([1, 9, 17, 20]);
  });

  it("chooses the newest saved guide for the running app", () => {
    const positions = {
      "1113000:10": { scrollTop: 1, updatedAt: 100 },
      "1113000:11": { scrollTop: 2, updatedAt: 300 },
      "222:20": { scrollTop: 3, updatedAt: 400 },
    };

    expect(findMostRecentGuide(positions, "1113000")).toEqual({
      appId: "1113000",
      guideId: "11",
    });
    expect(findMostRecentGuide(positions)).toEqual({
      appId: "222",
      guideId: "20",
    });
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

  it("never selects another game's observed guide while a game is running", () => {
    const otherGame = { appId: "222", guideId: "20" };
    const runningGame = { appId: "1113000", guideId: "11" };

    expect(chooseObservedGuide(otherGame, runningGame, "1113000")).toEqual(
      runningGame,
    );
    expect(chooseObservedGuide(otherGame, null, "1113000")).toBeNull();
    expect(chooseObservedGuide(otherGame, null)).toEqual(otherGame);
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
