// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GuideDocument } from "../../src/components/GuideDocument";

vi.mock("@decky/ui", async () => {
  const { mockDeckyElement } = await import("./helpers/decky-ui");
  return {
    DialogHeader: mockDeckyElement("div"),
    DialogBodyText: mockDeckyElement("div"),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("preserves hydrated nodes when the page rerenders or appends sections", async () => {
  const contentRef = createRef<HTMLDivElement>();
  const guide = {
    guideId: "20",
    sections: [
      {
        id: "first",
        title: "第一章",
        html: '<p>正文</p><img data-grip-image-url="https://images.example/map.png">',
      },
      { id: "second", title: "第二章", html: "<p>后文</p>" },
    ],
  };
  const render = (renderedSectionCount: number, currentGuide = guide) =>
    act(async () => {
      root.render(
        <GuideDocument
          guide={currentGuide}
          renderedSectionCount={renderedSectionCount}
          contentRef={contentRef}
        />,
      );
    });

  await render(1);
  const content = contentRef.current!;
  const section = content.querySelector("section");
  const image = content.querySelector("img")!;
  expect(image.getAttribute("src")).toBeNull();
  image.src = "blob:hydrated-map";
  image.dataset.gripImageState = "ready";
  image.width = 640;
  image.height = 480;

  await render(1, {
    ...guide,
    sections: guide.sections.map((section) => ({ ...section })),
  });
  await render(1);
  await render(2);
  expect(contentRef.current).toBe(content);
  expect(content.querySelector("section")).toBe(section);
  expect(content.querySelector("img")).toBe(image);
  expect(image.src).toBe("blob:hydrated-map");
  expect(image.dataset.gripImageState).toBe("ready");
  expect([image.width, image.height]).toEqual([640, 480]);
  expect(content.querySelectorAll("[data-guide-search-body]")).toHaveLength(2);
  expect(content.querySelector("style")).toBeNull();
});

it("replaces changed HTML but resets the document root only when the guide changes", async () => {
  const contentRef = createRef<HTMLDivElement>();
  const render = (guideId: string, html: string) =>
    act(async () => {
      root.render(
        <GuideDocument
          guide={{ guideId, sections: [{ id: "one", title: "章节", html }] }}
          renderedSectionCount={1}
          contentRef={contentRef}
        />,
      );
    });

  await render("20", '<p>旧版</p><img alt="旧图">');
  const content = contentRef.current!;
  const oldImage = content.querySelector("img");
  await render("20", '<p>新版</p><img alt="新图">');
  expect(contentRef.current).toBe(content);
  expect(content.querySelector("img")).not.toBe(oldImage);
  expect(content.textContent).toContain("新版");

  await render("21", '<p>另一篇</p><img alt="新图">');
  expect(contentRef.current).not.toBe(content);
  expect(content.isConnected).toBe(false);
  expect(contentRef.current?.textContent).toContain("另一篇");
});

it("owns bounded image and wrapping table styles without including styles in the searchable document", async () => {
  const contentRef = createRef<HTMLDivElement>();
  await act(async () => {
    root.render(
      <GuideDocument
        guide={{
          guideId: "20",
          sections: [
            {
              id: "one",
              title: "表格",
              html: '<div class="bb_table"><div class="bb_table_tr"><div class="bb_table_td"><img width="2048" height="512"></div></div></div><table width="3000"><tbody><tr><td>https://example.com/averylongunbrokentablecellvalue</td></tr></tbody></table>',
            },
          ],
        }}
        renderedSectionCount={1}
        contentRef={contentRef}
      />,
    );
  });

  const content = contentRef.current!;
  expect(content.querySelector("style")).toBeNull();
  for (const table of content.querySelectorAll(".bb_table, table")) {
    expect(getComputedStyle(table).tableLayout).toBe("fixed");
    expect(getComputedStyle(table).width).toBe("100%");
    const cell = table.querySelector(".bb_table_td, td")!;
    expect(getComputedStyle(cell).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(cell).whiteSpace).toBe("normal");
  }
  expect(getComputedStyle(content.querySelector("img")!).maxWidth).toBe("100%");
});
