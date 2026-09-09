import { expect, test, type Locator, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors()).toEqual([]);
});

const reader = (page: Page) => page.locator('[aria-label="指南正文"]');
const openReader = async (page: Page) => {
  await page.goto("/");
  await expect(page.locator("[data-guide-section-id]")).toHaveCount(18);
  await expect(reader(page)).toBeFocused();
  await page.locator(".grip-reader-content").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
};
const expectChoiceInsideList = async (choice: Locator) => {
  await expect(choice).toBeFocused();
  await expect
    .poll(() =>
      choice.evaluate((element) => {
        const card = element.getBoundingClientRect();
        const list = element
          .closest('[data-grip-guide-list="true"]')!
          .getBoundingClientRect();
        return (
          card.top >= list.top - 1 &&
          card.bottom <= list.bottom + 1 &&
          card.left >= list.left - 1 &&
          card.right <= list.right + 1
        );
      }),
    )
    .toBe(true);
};

test("1280×800: browser focus and Tab reveal long-list cards without scrolling the reader", async ({
  page,
}) => {
  await openReader(page);
  const before = await reader(page).evaluate((element) => element.scrollTop);
  await page.keyboard.press("F2");
  const choices = page.locator("[data-grip-guide-choice]");
  await expect(choices).toHaveCount(20);
  await expect(page.locator("[data-grip-guide-list]")).toHaveAttribute(
    "data-native-scroll-panel",
    "y",
  );
  await expect(choices.first()).toHaveAttribute("data-native-field", "true");
  await expect(choices.first().locator("[data-native-marquee]")).toHaveCount(1);
  await expect(choices.first().locator("button")).toHaveCount(0);
  await expectChoiceInsideList(choices.nth(1));
  // Chromium owns this focus/scroll behavior; the fixture does not emulate Steam spatial navigation.
  await choices.last().focus();
  await expectChoiceInsideList(choices.last());
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Shift+Tab");
    await expectChoiceInsideList(choices.nth(18 - index));
  }
  await choices.first().focus();
  await expectChoiceInsideList(choices.first());
  await page.keyboard.press("Tab");
  await expectChoiceInsideList(choices.nth(1));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "切换指南" })).toHaveCount(0);
  await expect(reader(page)).toBeFocused();
  expect(await reader(page).evaluate((element) => element.scrollTop)).toBe(
    before,
  );
});

test("1280×800: native and Steam wide tables wrap their cells within the real reading width", async ({
  page,
}) => {
  await openReader(page);
  const images = page.getByAltText("表格中的离线图片");
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("src", /^blob:/);
    await image.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
    });
    expect(
      await image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth === 96,
      ),
    ).toBe(true);
  }
  const measurements = await reader(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return {
      viewportWidth: viewport.width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      tables: [...element.querySelectorAll("table, .bb_table")].map((table) => {
        const rect = table.getBoundingClientRect();
        return {
          left: rect.left - viewport.left,
          right: rect.right - viewport.right,
          width: rect.width,
          overflowCells: [
            ...table.querySelectorAll<HTMLElement>("td, .bb_table_td"),
          ].filter((cell) => {
            const box = cell.getBoundingClientRect();
            return (
              cell.scrollWidth > cell.clientWidth + 1 ||
              box.left < viewport.left ||
              box.right > viewport.right + 1
            );
          }).length,
        };
      }),
    };
  });
  expect(measurements.viewportWidth).toBeGreaterThan(800);
  expect(measurements.scrollWidth).toBeLessThanOrEqual(
    measurements.clientWidth + 1,
  );
  expect(measurements.tables).toHaveLength(2);
  for (const table of measurements.tables) {
    expect(table.width).toBeGreaterThan(500);
    expect(table.left).toBeGreaterThanOrEqual(0);
    expect(table.right).toBeLessThanOrEqual(1);
    expect(table.overflowCells).toBe(0);
  }
});

test("1280×800: the fullscreen image portal measures its viewport and returns to the same article position", async ({
  page,
}) => {
  await openReader(page);
  const articleImage = reader(page).getByAltText("延迟解码的离线长图");
  await articleImage.scrollIntoViewIfNeeded();
  await expect(articleImage).toHaveAttribute("data-grip-image-state", "ready");
  await articleImage.evaluate((element: HTMLImageElement) => element.decode());
  await reader(page).focus();
  await expect(reader(page)).toHaveAttribute("data-ok-action", "查看图片");
  const before = await reader(page).evaluate((element) => ({
    scrollTop: element.scrollTop,
    imageTop: element
      .querySelector<HTMLImageElement>('img[alt="延迟解码的离线长图"]')!
      .getBoundingClientRect().top,
  }));

  await page.keyboard.press("Enter");
  const viewer = page.getByRole("dialog", { name: "图片全屏查看" });
  await expect(viewer).toBeVisible();
  const preview = viewer.getByAltText("延迟解码的离线长图");
  await preview.evaluate((element: HTMLImageElement) => element.decode());
  const measure = () =>
    preview.evaluate((element: HTMLImageElement) => {
      const viewport = element.closest<HTMLElement>(".grip-image-viewport")!;
      const rect = element.getBoundingClientRect();
      return {
        viewWidth: viewport.clientWidth,
        viewHeight: viewport.clientHeight,
        width: rect.width,
        height: rect.height,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
      };
    });
  const initial = await measure();
  expect(initial.naturalWidth).toBe(900);
  expect(initial.naturalHeight).toBe(1600);
  expect(initial.viewWidth).toBeGreaterThan(800);
  expect(initial.viewHeight).toBeGreaterThan(300);
  // This must hold before a second fit: measuring before the portal mounts yields a 1px image.
  expect(initial.width).toBeGreaterThan(200);
  expect(initial.width / initial.height).toBeCloseTo(900 / 1600, 3);

  await viewer.getByRole("button", { name: "适应屏幕" }).click();
  const fitWidth =
    900 *
    Math.min(
      1,
      (initial.viewWidth - 32) / 900,
      (initial.viewHeight - 32) / 1600,
    );
  await expect
    .poll(async () => Math.abs((await measure()).width - fitWidth))
    .toBeLessThanOrEqual(1);
  await expect(preview).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(reader(page)).toBeFocused();
  const after = await reader(page).evaluate((element) => ({
    scrollTop: element.scrollTop,
    imageTop: element
      .querySelector<HTMLImageElement>('img[alt="延迟解码的离线长图"]')!
      .getBoundingClientRect().top,
  }));
  expect(after).toEqual(before);
});

test("1280×800: a search hit stays visible after a delayed local image really loads and decodes", async ({
  page,
}) => {
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/image-ready", async (route) => {
    await heldResponse;
    await route.fulfill({ status: 204 });
  });
  try {
    await openReader(page);
    await page.keyboard.press("Control+f");
    const input = page.getByRole("textbox", { name: "搜索指南正文" });
    // F3 represents only the bubbling X action, not Steam's keyboard UI.
    await input.press("F3");
    await expect(input).toBeFocused();
    await input.fill("精确命中");
    await input.press("F3");
    await expect(input).toHaveValue("精确命中");
    await expect(input).toBeFocused();
    await expect(
      page.getByRole("button", { name: /^跳转到搜索结果 1/ }),
    ).toBeVisible();
    await input.press("Enter");
    const image = page.getByAltText("延迟解码的离线长图");
    await expect(image).toHaveAttribute("data-grip-image-state", "loading");
    const before = await page
      .locator("[data-fixture-hit]")
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().top;
      });
    const scrollBefore = await reader(page).evaluate(
      (element) => element.scrollTop,
    );
    release();
    await expect(image).toHaveAttribute("src", /^blob:/);
    await image.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
    });
    expect(
      await image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalHeight === 1600,
      ),
    ).toBe(true);
    await expect
      .poll(() => reader(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBefore + 1_000);
    await expect
      .poll(() =>
        page.locator("[data-fixture-hit]").evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const hit = range.getBoundingClientRect();
          const viewport = element
            .closest('[aria-label="指南正文"]')!
            .getBoundingClientRect();
          return hit.top >= viewport.top && hit.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
    const after = await page
      .locator("[data-fixture-hit]")
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThan(30);
  } finally {
    release();
  }
});

test("1280×800: opening and closing the chapter panel keeps the article width and reading position", async ({
  page,
}) => {
  await openReader(page);
  for (let index = 0; index < 8; index++)
    await page.keyboard.press("ArrowDown");
  const measure = () =>
    reader(page).evaluate((element) => ({
      top: element.scrollTop,
      width: element.getBoundingClientRect().width,
      sectionTop: element
        .querySelector('[data-guide-section-id="2"]')!
        .getBoundingClientRect().top,
    }));
  const before = await measure();
  expect(before.top).toBeGreaterThan(500);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "指南目录" })).toBeVisible();
  const opened = await measure();
  expect(opened).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("navigation", { name: "指南目录" }),
  ).toBeVisible();
  await expect(reader(page)).toBeFocused();
  expect(await measure()).toEqual(before);
});
