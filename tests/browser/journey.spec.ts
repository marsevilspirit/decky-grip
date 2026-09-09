import { expect, test, type Page } from "@playwright/test";
import type { ReaderPosition } from "../../src/reader/types";

const guideA = "3414883877";
const guideB = "3414883878";
const reader = (page: Page) =>
  page.getByRole("region", { name: "指南正文", includeHidden: true });
const choice = (page: Page, guideId: string) =>
  page.locator(`[data-grip-guide-choice="1113000:${guideId}"]`);
const savedPosition = (
  page: Page,
  guideId: string,
): Promise<ReaderPosition | null> =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    `grip-browser:position:1113000:${guideId}`,
  );

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors()).toEqual([]);
});

async function expectReader(page: Page, guideId: string) {
  await expect(page.locator("[data-fixture-route]")).toHaveAttribute(
    "data-fixture-route",
    guideId,
  );
  await expect(page.getByRole("dialog", { name: "切换指南" })).toHaveCount(0);
  await expect(reader(page).locator("[data-guide-section-id]")).toHaveCount(18);
  await expect(reader(page).locator("p").first()).toContainText(
    `指南 ${Number(guideId) - Number(guideA) + 1}，`,
  );
  await expect(reader(page)).toBeFocused();
  await page.locator(".grip-reader-content").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
}

async function scrollDown(page: Page, count: number) {
  for (let index = 0; index < count; index++)
    await page.keyboard.press("ArrowDown");
}

async function rememberPosition(page: Page, guideId: string) {
  await expect
    .poll(async () => (await savedPosition(page, guideId))?.scrollTop ?? 0)
    .toBeGreaterThan(500);
  const position = (await savedPosition(page, guideId))!;
  expect(position.anchorText).toBeTruthy();
  expect(position.sectionId).not.toBeNull();
  return position;
}

async function expectRestored(page: Page, position: ReaderPosition) {
  await expect
    .poll(async () =>
      Math.abs(
        (await reader(page).evaluate((element) => element.scrollTop)) -
          position.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  // The bookmark must restore the actual text line, not merely replay a scroll number.
  const anchor = reader(page).getByText(position.anchorText!, { exact: true });
  await expect(anchor).toBeInViewport();
  await expect
    .poll(() =>
      anchor.evaluate((element, offset) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const viewport = element
          .closest('[aria-label="指南正文"]')!
          .getBoundingClientRect();
        return Math.abs(
          range.getBoundingClientRect().top - viewport.top - offset,
        );
      }, position.anchorOffset),
    )
    .toBeLessThanOrEqual(2);
}

async function switchTo(page: Page, guideId: string) {
  await page.keyboard.press("F2");
  await choice(page, guideId).click();
  await expectReader(page, guideId);
}

test("A → B → A preserves independent bookmarks and renders each real guide", async ({
  page,
}) => {
  await page.goto("/?scenario=journey");
  await expectReader(page, guideA);
  await scrollDown(page, 12);
  const positionA = await rememberPosition(page, guideA);

  await switchTo(page, guideB);
  expect(await reader(page).evaluate((element) => element.scrollTop)).toBe(0);
  await scrollDown(page, 6);
  const positionB = await rememberPosition(page, guideB);
  expect(positionA.anchorText).not.toBe(positionB.anchorText);

  await switchTo(page, guideA);
  await expectRestored(page, positionA);
  await switchTo(page, guideB);
  await expectRestored(page, positionB);
});

test("closing, reopening and reloading consume the bookmark saved by the reader", async ({
  page,
}) => {
  await page.goto("/?scenario=journey");
  await expectReader(page, guideA);
  await scrollDown(page, 12);
  const position = await rememberPosition(page, guideA);

  await page.keyboard.press("Escape");
  await expect(reader(page)).toHaveCount(0);
  await expect(
    page.getByRole("main", { name: "本地游戏占位页" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续阅读" }).click();
  await expectReader(page, guideA);
  await expectRestored(page, position);

  // A new page creates a new ReaderSessionCache: only the persisted backend record survives.
  await page.reload();
  await expectReader(page, guideA);
  await expectRestored(page, position);
  expect((await savedPosition(page, guideA))?.anchorText).toBe(
    position.anchorText,
  );
});

test("a failed switch keeps the old guide and retries the selected card without duplicate loads", async ({
  page,
}) => {
  let attempts = 0;
  let release!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/fixture/guide/${guideB}`, async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        body: "本地指南读取失败（测试注入）",
      });
    } else {
      await responseHeld;
      await route.fulfill({ status: 204 });
    }
  });
  try {
    await page.goto("/?scenario=journey");
    await expectReader(page, guideA);
    await scrollDown(page, 12);
    const position = await rememberPosition(page, guideA);
    await page.keyboard.press("F2");
    const target = choice(page, guideB);
    await target.click();
    await expect(target.getByRole("alert")).toContainText(
      "本地指南读取失败（测试注入）",
    );
    await expect(target).toBeFocused();
    await expect(page.locator("[data-fixture-route]")).toHaveAttribute(
      "data-fixture-route",
      guideA,
    );
    await expectRestored(page, position);

    await target.press("Enter");
    await expect(target).toHaveAttribute("aria-busy", "true");
    await expect(target).toContainText("正在准备并打开");
    await target.press("Enter");
    expect(attempts).toBe(2);
    await expect(page.locator("[data-fixture-route]")).toHaveAttribute(
      "data-fixture-route",
      guideA,
    );
    release();
    await expectReader(page, guideB);
    await switchTo(page, guideA);
    await expectRestored(page, position);
  } finally {
    release();
  }
});

test("a failed position write can be retried and survives a cold page reload", async ({
  page,
}) => {
  let attempts = 0;
  await page.route(`**/fixture/position/1113000:${guideA}`, async (route) => {
    attempts++;
    await route.fulfill(
      attempts === 1
        ? { status: 503, body: "本地位置写入失败（测试注入）" }
        : { status: 204 },
    );
  });
  await page.goto("/?scenario=journey");
  await expectReader(page, guideA);
  await scrollDown(page, 12);
  await expect(page.getByRole("alert")).toContainText(
    "本地位置写入失败（测试注入）",
  );
  expect(await savedPosition(page, guideA)).toBeNull();
  const scrollTop = await reader(page).evaluate((element) => element.scrollTop);
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const position = await rememberPosition(page, guideA);
  expect(Math.abs(position.scrollTop - scrollTop)).toBeLessThanOrEqual(2);
  expect(attempts).toBe(2);
  await page.reload();
  await expectReader(page, guideA);
  await expectRestored(page, position);
});

test("uninstalling B preserves A's reading position and B's bookmark while C remains manageable", async ({
  page,
}) => {
  const guideC = "3414883879";
  const confirmation = page.getByRole("dialog", { name: /^管理指南：/ });
  let removals = 0;
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/fixture/remove/${guideB}`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    removals++;
    if (removals === 2) {
      await route.fulfill({
        status: 503,
        body: "残留图片清理失败（测试注入）",
      });
      return;
    }
    await heldResponse;
    await route.fulfill({ status: 204 });
  });
  try {
    await page.goto("/?scenario=journey");
    await expectReader(page, guideA);
    await scrollDown(page, 12);
    const positionA = await rememberPosition(page, guideA);
    await switchTo(page, guideB);
    await scrollDown(page, 6);
    const positionB = await rememberPosition(page, guideB);
    await switchTo(page, guideA);
    await expectRestored(page, positionA);

    await page.keyboard.press("F2");
    await expect(page.getByRole("button", { name: /^管理指南：/ })).toHaveCount(
      0,
    );
    await choice(page, guideB).focus();
    await choice(page, guideB).press("F3");
    await expect(confirmation).toHaveAccessibleName(/^管理指南：第 2 篇/);
    await expect(
      confirmation.getByRole("button", { name: "取消" }),
    ).toBeFocused();
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(choice(page, guideB)).toBeFocused();
    expect(removals).toBe(0);

    // A mouse can manage a different row without first reading or focusing it.
    await choice(page, guideC).click({ button: "right" });
    await expect(confirmation).toHaveAccessibleName(/^管理指南：第 3 篇/);
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(choice(page, guideC)).toBeFocused();
    await expectRestored(page, positionA);
    expect(removals).toBe(0);

    await choice(page, guideB).click({ button: "right" });
    await expect(confirmation).toHaveAccessibleName(/^管理指南：第 2 篇/);
    await confirmation.getByRole("button", { name: /^确认卸载/ }).click();
    await expect(
      confirmation.getByRole("button", { name: /正在卸载/ }),
    ).toHaveClass(/\bDisabled\b/);
    await expect(
      confirmation.getByRole("button", { name: "取消" }),
    ).toHaveClass(/\bDisabled\b/);
    await expect.poll(() => removals).toBe(1);
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await expectRestored(page, positionA);
    release();
    await expect(confirmation).toHaveCount(0);
    await expect(choice(page, guideB)).toContainText("离线副本已卸载");
    await expect(choice(page, guideB)).toBeFocused();
    await expect(choice(page, guideC)).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    expect((await savedPosition(page, guideB))?.anchorText).toBe(
      positionB.anchorText,
    );
    expect((await savedPosition(page, guideB))?.scrollTop).toBe(
      positionB.scrollTop,
    );
    await page.keyboard.press("Escape");
    await expectReader(page, guideA);
    await expectRestored(page, positionA);

    // A cold page recreates the cache and library from the fixture's persisted backend state.
    await page.reload();
    await expectReader(page, guideA);
    await expectRestored(page, positionA);
    await page.keyboard.press("F2");
    await expect(choice(page, guideB)).toContainText("未下载离线副本");
    await choice(page, guideB).press("F3");
    const cleanRemaining = confirmation.getByRole("button", {
      name: "确认清理残留",
    });
    await expect(cleanRemaining).not.toHaveClass(/\bDisabled\b/);
    expect(removals).toBe(1);
    await cleanRemaining.click();
    await expect(confirmation.getByRole("alert")).toContainText(
      "残留图片清理失败（测试注入）",
    );
    await expect.poll(() => removals).toBe(2);
    await expectRestored(page, positionA);
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(choice(page, guideB)).toBeFocused();

    // Retry eligibility must survive closing management, not depend on its old error state.
    await choice(page, guideB).press("F3");
    await expect(confirmation.getByRole("alert")).toHaveCount(0);
    await expect(cleanRemaining).not.toHaveClass(/\bDisabled\b/);
    await cleanRemaining.click();
    await expect.poll(() => removals).toBe(3);
    await expect(confirmation).toHaveCount(0);
    await expect(choice(page, guideB)).toContainText("离线副本已卸载");
    await expect(choice(page, guideB)).toBeFocused();
    await choice(page, guideC).press("F3");
    await expect(confirmation).toHaveAccessibleName(/^管理指南：第 3 篇/);
    await expect(
      confirmation.getByRole("button", { name: "确认卸载" }),
    ).not.toHaveClass(/\bDisabled\b/);
    await confirmation.getByRole("button", { name: "取消" }).click();
    await expect(choice(page, guideC)).toBeFocused();
    expect(removals).toBe(3);
    expect((await savedPosition(page, guideB))?.anchorText).toBe(
      positionB.anchorText,
    );
    await page.keyboard.press("Escape");
    await expectReader(page, guideA);
    await expectRestored(page, positionA);
  } finally {
    release();
  }
});
