import { describe, expect, it, vi } from "vitest";

import { findGuideScroller } from "../../src/steam/guide-scroll";

interface FakeElementOptions {
  connected?: boolean;
  topPadding?: string;
  bottomPadding?: string;
  overflowY?: string;
  width?: number;
  height?: number;
  clientHeight?: number;
  scrollHeight?: number;
  scrollTop?: number;
  imagesComplete?: boolean[];
}

function makeElement(options: FakeElementOptions = {}) {
  const scrollTo = vi.fn(({ top }: { top: number }) => {
    element.scrollTop = top;
  });
  const element = {
    isConnected: options.connected ?? true,
    style: {
      scrollPaddingTop: options.topPadding ?? "20px",
      scrollPaddingBottom: options.bottomPadding ?? "20px",
    },
    clientHeight: options.clientHeight ?? 400,
    scrollHeight: options.scrollHeight ?? 2_000,
    scrollTop: options.scrollTop ?? 0,
    overflowY: options.overflowY ?? "auto",
    getBoundingClientRect: () => ({
      width: options.width ?? 700,
      height: options.height ?? 400,
    }),
    querySelectorAll: () =>
      (options.imagesComplete ?? [true]).map((complete) => ({ complete })),
    scrollTo,
  };
  return element;
}

function makeDocument(elements: ReturnType<typeof makeElement>[]): Document {
  return {
    defaultView: {
      getComputedStyle(element: ReturnType<typeof makeElement>) {
        return {
          display: "block",
          visibility: "visible",
          overflowY: element.overflowY,
        };
      },
    },
    querySelectorAll: () => elements,
  } as unknown as Document;
}

describe("Steam guide scroll panel", () => {
  it("finds the unique visible detail panel and exposes live measurements", () => {
    const element = makeElement({
      scrollTop: 5561.3335,
      scrollHeight: 9_000,
      imagesComplete: [true, true],
    });
    const scroller = findGuideScroller(makeDocument([element]));

    expect(scroller?.scrollTop).toBe(5561.3335);
    expect(scroller?.scrollHeight).toBe(9_000);
    expect(scroller?.imagesComplete).toBe(true);
    scroller?.scrollTo(1234);
    expect(element.scrollTo).toHaveBeenCalledWith({
      top: 1234,
      behavior: "auto",
    });
  });

  it("excludes the guide list and non-scrollable panels", () => {
    expect(
      findGuideScroller(makeDocument([makeElement({ topPadding: "200px" })])),
    ).toBeNull();
    expect(
      findGuideScroller(makeDocument([makeElement({ overflowY: "hidden" })])),
    ).toBeNull();
  });

  it("fails closed when more than one detail panel matches", () => {
    expect(
      findGuideScroller(makeDocument([makeElement(), makeElement()])),
    ).toBeNull();
  });

  it("reports incomplete lazy-loaded images", () => {
    const scroller = findGuideScroller(
      makeDocument([makeElement({ imagesComplete: [true, false] })]),
    );
    expect(scroller?.imagesComplete).toBe(false);
  });
});
