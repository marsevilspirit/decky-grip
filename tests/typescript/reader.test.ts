import { describe, expect, it } from "vitest";

import {
  closestAnchorScrollTop,
  normalizeAnchorText,
} from "../../src/reader/anchor";
import {
  chooseObservedGuide,
  findMostRecentGuide,
} from "../../src/reader/recent-guide";
import { shortSectionTitle } from "../../src/reader/toc-title";

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

  it("never selects another game's observed guide while a game is running", () => {
    const otherGame = { appId: "222", guideId: "20" };
    const runningGame = { appId: "1113000", guideId: "11" };

    expect(chooseObservedGuide(otherGame, runningGame, "1113000")).toEqual(
      runningGame,
    );
    expect(chooseObservedGuide(otherGame, null, "1113000")).toBeNull();
    expect(chooseObservedGuide(otherGame, null)).toEqual(otherGame);
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
