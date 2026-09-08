import { expect, test } from "@playwright/test";

test("600 cached images: one viewport pass for a same-frame scroll burst, with correct image and bookmark actions", async ({
  page,
}) => {
  await page.goto("/?scenario=scroll");
  const reader = page.getByRole("region", { name: "指南正文" });
  const content = page.locator(".grip-reader-content");
  await expect(content.locator("img")).toHaveCount(600);
  await expect(reader).toBeFocused();
  await content.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });

  // Reach a deep chapter, then move backwards so newly observed earlier images
  // need not have the same insertion order as the images retained in the visible set.
  await page.keyboard.press("F3");
  await page
    .getByRole("button", { name: "跳转到章节：指南 1 · 第 12 章", exact: true })
    .click();
  await expect(reader).toBeFocused();
  await expect(reader).toHaveAttribute("data-ok-action", "查看图片");
  for (let index = 0; index < 18; index++) await page.keyboard.press("ArrowUp");
  const top = await reader.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(10_000);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const position = JSON.parse(
          localStorage.getItem("grip-browser:position:1113000:3414883877") ??
            "null",
        );
        return position?.scrollTop;
      }),
    )
    .toBe(top);

  // The saved user scroll also means the initial restoration no longer owns a
  // timer. Wait for actual viewport PNG decoding and native observer delivery.
  await expect
    .poll(() =>
      reader.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const visible = [...element.querySelectorAll("img")].filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        return (
          visible.length > 0 &&
          visible.every((image) => image.complete && image.naturalWidth === 96)
        );
      }),
    )
    .toBe(true);

  const measured = await reader.evaluate(async (element) => {
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const body = element.querySelector<HTMLElement>(".grip-reader-content")!;
    const images = [...body.querySelectorAll("img")];
    await Promise.all(
      images
        .filter((image) => image.hasAttribute("src"))
        .map((image) => image.decode()),
    );
    await frame();
    await frame();
    const viewport = element.getBoundingClientRect();
    const visible = images.filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const sections = [
      ...body.querySelectorAll<HTMLElement>("[data-guide-section-id]"),
    ];
    const current =
      sections
        .filter(
          (section) => section.getBoundingClientRect().top <= viewport.top + 1,
        )
        .pop() ?? sections[0];

    const nativeQuery = Element.prototype.querySelectorAll;
    const nativeRect = Element.prototype.getBoundingClientRect;
    const queries: string[] = [];
    const reads = new Map<Element, number>();
    Element.prototype.querySelectorAll = function (
      this: Element,
      selector: string,
    ) {
      if (this === body) queries.push(selector);
      return nativeQuery.call(this, selector);
    } as typeof nativeQuery;
    Element.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLImageElement && body.contains(this))
        reads.set(this, (reads.get(this) ?? 0) + 1);
      return nativeRect.call(this);
    };
    try {
      for (let index = 0; index < 100; index++)
        element.dispatchEvent(new Event("scroll"));
      const synchronousReads = [...reads.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      const synchronousQueries = queries.length;
      await frame();
      return {
        synchronousReads,
        synchronousQueries,
        queries,
        totalImages: images.length,
        measuredImages: reads.size,
        maxReadsPerImage: Math.max(0, ...reads.values()),
        firstVisibleAlt: visible[0]?.alt,
        visibleCount: visible.length,
        sectionId: current.dataset.guideSectionId!,
        scrollTop: element.scrollTop,
      };
    } finally {
      // Instrumentation always invokes and restores the original DOM methods.
      Element.prototype.querySelectorAll = nativeQuery;
      Element.prototype.getBoundingClientRect = nativeRect;
    }
  });
  await test.info().attach("viewport-work", {
    body: JSON.stringify(measured, null, 2),
    contentType: "application/json",
  });
  expect(measured.synchronousReads).toBe(0);
  expect(measured.synchronousQueries).toBe(0);
  expect(measured.queries).toEqual([]);
  expect(measured.measuredImages).toBeGreaterThanOrEqual(measured.visibleCount);
  expect(measured.measuredImages).toBeLessThan(measured.totalImages / 10);
  expect(measured.maxReadsPerImage).toBe(1);
  expect(measured.visibleCount).toBeGreaterThan(1);
  await expect(
    page.locator(`[data-grip-toc-section="${measured.sectionId}"]`),
  ).toHaveAttribute("aria-current", "location");

  await expect(reader).toHaveAttribute("data-ok-action", "查看图片");
  await page.keyboard.press("Enter");
  const viewer = page.getByRole("dialog", { name: "图片全屏查看" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toHaveAttribute(
    "alt",
    measured.firstVisibleAlt!,
  );
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(reader).toBeFocused();
  expect(await reader.evaluate((element) => element.scrollTop)).toBe(
    measured.scrollTop,
  );
  const saved = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("grip-browser:position:1113000:3414883877") ??
        "null",
    ),
  );
  expect(saved.scrollTop).toBe(measured.scrollTop);
  expect(saved.sectionId).toBe(measured.sectionId);
  expect(saved.anchorText).toContain(`第 ${measured.sectionId} 章`);
  expect(await page.pageErrors()).toEqual([]);
});
