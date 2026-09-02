// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  buildGuideSearchIndex,
  locateGuideSearchRange,
  searchGuideIndex,
} from "../../src/reader/search";
import type { DownloadedGuide } from "../../src/reader/types";

function guideFixture(sections: DownloadedGuide["sections"]): DownloadedGuide {
  return {
    guideId: "10",
    title: "Boss Route Guide",
    author: "Tester",
    sourceUrl: "https://example.com/guide/10",
    fetchedAt: 1,
    fromCache: true,
    stale: false,
    sections,
  };
}

describe("guide reader search", () => {
  it("returns every title and body occurrence with readable snippets", () => {
    const index = buildGuideSearchIndex(
      guideFixture([
        {
          id: "intro",
          title: "Getting Started",
          html: "<p>Rock &amp; <strong>Roll</strong> route</p>",
        },
        {
          id: "boss",
          title: "Final BOSS",
          html: "<p>Keep <strong>mov</strong>ing, then keep moving.</p><p>Second block.</p>",
        },
      ]),
    );

    expect(searchGuideIndex(index, "  boss   route  ").matches).toEqual([
      {
        sectionId: null,
        title: "Boss Route Guide",
        kind: "guide-title",
        occurrence: 0,
        snippet: "Boss Route Guide",
      },
    ]);
    expect(searchGuideIndex(index, "final boss").matches[0]).toMatchObject({
      sectionId: "boss",
      kind: "section-title",
      occurrence: 0,
      snippet: "Final BOSS",
    });
    expect(
      searchGuideIndex(index, "rock & roll route").matches[0],
    ).toMatchObject({
      sectionId: "intro",
      kind: "body",
      snippet: "Rock & Roll route",
    });
    const repeated = searchGuideIndex(index, "keep moving");
    expect(repeated.matches).toHaveLength(2);
    expect(repeated.matches.map((result) => result.occurrence)).toEqual([0, 1]);
    expect(repeated.matches[0]?.snippet).toContain(
      "Keep moving, then keep moving.",
    );
    expect(searchGuideIndex(index, "moving.second").matches).toEqual([]);
    expect(searchGuideIndex(index, "   ")).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("locates repeated matches across inline elements without changing the DOM", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>Before <strong>Keep</strong> moving, then keep moving.</p>";
    const before = root.innerHTML;

    expect(locateGuideSearchRange(root, "keep moving", 0)?.toString()).toBe(
      "Keep moving",
    );
    expect(locateGuideSearchRange(root, "KEEP MOVING", 1)?.toString()).toBe(
      "keep moving",
    );
    expect(locateGuideSearchRange(root, "keep moving", 2)).toBeNull();
    expect(root.innerHTML).toBe(before);
  });

  it("returns all normal matches and reports the explicit safety limit", () => {
    const complete = searchGuideIndex(
      buildGuideSearchIndex(
        guideFixture(
          Array.from({ length: 75 }, (_, index) => ({
            id: String(index + 1),
            title: `Section ${index + 1}`,
            html: "<p>shared needle</p>",
          })),
        ),
      ),
      "needle",
    );
    expect(complete.matches).toHaveLength(75);
    expect(complete.matches[74]?.sectionId).toBe("75");
    expect(complete.truncated).toBe(false);

    const limited = searchGuideIndex(
      buildGuideSearchIndex(
        guideFixture([
          {
            id: "many",
            title: "Many matches",
            html: `<p>${"needle ".repeat(205)}</p>`,
          },
        ]),
      ),
      "needle",
    );
    expect(limited.matches).toHaveLength(200);
    expect(limited.matches[199]?.occurrence).toBe(199);
    expect(limited.truncated).toBe(true);

    const emojiSnippet = searchGuideIndex(
      buildGuideSearchIndex(
        guideFixture([
          {
            id: "emoji",
            title: "Emoji boundaries",
            html: `<p>${"a".repeat(10)}😀${"b".repeat(35)}needle${"c".repeat(35)}😀z</p>`,
          },
        ]),
      ),
      "needle",
    ).matches[0]?.snippet;
    expect(emojiSnippet?.startsWith("…😀")).toBe(true);
    expect(emojiSnippet?.endsWith("😀…")).toBe(true);
  });
});
