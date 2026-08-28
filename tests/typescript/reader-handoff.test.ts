import { describe, expect, it } from "vitest";

import { captureNativeReaderHandoff } from "../../src/steam/reader-handoff";

interface FakeText extends Partial<Text> {
  contentTop: number;
  contentBottom: number;
  textContent: string;
}

function makeScroller(nodes: FakeText[], scrollTop = 0): HTMLElement {
  const viewportTop = 45;
  let preparedNodes: FakeText[] = [];
  const document = {
    defaultView: { NodeFilter: { SHOW_TEXT: 4 } },
    createTreeWalker: () => {
      let index = 0;
      return {
        nextNode: () => preparedNodes[index++] ?? null,
      };
    },
    createRange: () => {
      let selected: FakeText;
      return {
        selectNodeContents: (node: FakeText) => {
          selected = node;
        },
        getBoundingClientRect: () => ({
          top: viewportTop + selected.contentTop - scrollTop,
          bottom: viewportTop + selected.contentBottom - scrollTop,
          width: 500,
          height: selected.contentBottom - selected.contentTop,
        }),
      };
    },
  };
  preparedNodes = nodes.map(
    (node) =>
      ({
        ...node,
        nodeType: 3,
        ownerDocument: document as unknown as Document,
        parentElement: null,
      }) as unknown as FakeText,
  );
  return {
    clientHeight: 442,
    getBoundingClientRect: () => ({ top: viewportTop }),
    ownerDocument: document,
    scrollHeight: 67_714,
    scrollTop,
  } as unknown as HTMLElement;
}

describe("native guide to reader handoff", () => {
  it("uses the saved native position to capture 4/23 after Steam snaps upward", () => {
    const scroller = makeScroller([
      {
        contentTop: 2_000,
        contentBottom: 2_024,
        textContent: "四月",
      },
      {
        contentTop: 3_956.6,
        contentBottom: 3_980,
        textContent: "4/23",
      },
      {
        contentTop: 4_056.3,
        contentBottom: 4_138.6,
        textContent:
          "去河堤下方与老人对话，再去神社与抓虫子的少年对话，最后去商店街北侧售货机买果汁",
      },
    ]);

    const handoff = captureNativeReaderHandoff(scroller, 4_040);

    expect(handoff).toMatchObject({
      scrollTop: 4_040,
      anchorText:
        "去河堤下方与老人对话，再去神社与抓虫子的少年对话，最后去商店街北侧售货机买果汁",
    });
    expect(handoff?.anchorOffset).toBeCloseTo(16.3);
    expect(scroller.scrollTop).toBe(0);
  });

  it("rejects an invalid native target", () => {
    expect(captureNativeReaderHandoff(makeScroller([]), -1)).toBeNull();
  });
});
