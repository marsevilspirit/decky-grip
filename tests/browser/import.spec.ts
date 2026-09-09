import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";

const share =
  "小黑盒公开攻略 https://www.xiaoheihe.cn/app/bbs/link/249c72219fed";
const publication = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("grip-browser:import-publication") ?? "null",
    ),
  );
const events = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("grip-browser:import-events") ?? "[]"),
  );

async function sendFromPhone(page: Page) {
  await page.goto("/?scenario=import");
  await page
    .getByRole("button", { name: "手机扫码发送链接", exact: true })
    .click();
  const image = page.getByAltText("手机发送小黑盒链接的临时二维码");
  await expect(image).toBeVisible();
  // Decode the generated image at its rendered size, not a captured RPC URL or a
  // patched encoder. This tests the QR actually shown by the real PhoneImport.
  const pixels = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement("canvas");
    const rect = element.getBoundingClientRect();
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    return {
      data: [...context.getImageData(0, 0, canvas.width, canvas.height).data],
      width: canvas.width,
      height: canvas.height,
    };
  });
  const decoded = jsQR(
    new Uint8ClampedArray(pixels.data),
    pixels.width,
    pixels.height,
  );
  expect(decoded?.data).toMatch(/^http:\/\/localhost:\d+\/#[-\w]+$/);
  const phone = await page.context().newPage();
  try {
    // This is Rust's actual phone-import.html, token validation and HTTP server.
    await phone.goto(decoded!.data);
    await expect(
      phone.getByRole("heading", { name: "发送指南到 Steam Deck" }),
    ).toBeVisible();
    expect(new URL(phone.url()).hash).toBe("");
    await phone.getByRole("textbox", { name: "分享文字或链接" }).fill(share);
    await phone.getByRole("button", { name: "发送到 Deck" }).click();
    await expect(phone.getByRole("status")).toHaveText(
      "已发送到 Deck，待确认并下载，不代表导入成功",
    );
    await expect(page.getByRole("textbox", { name: "分享链接" })).toHaveValue(
      share,
    );
    await expect(page.getByRole("dialog")).toContainText("尚未下载");
    await expect(image).toHaveCount(0);
    expect(await publication(page)).toBeNull();
    expect(await events(page)).toEqual([]);
    expect(await phone.pageErrors()).toEqual([]);
  } finally {
    await phone.close();
  }
}

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors()).toEqual([]);
});

test("real QR → Rust phone submission → confirmed game → complete offline transaction → reader", async ({
  page,
}) => {
  let releaseImage!: () => void;
  let releaseCommit!: () => void;
  const imageHeld = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const commitHeld = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let imageRequests = 0;
  let commits = 0;
  await page.route("**/fixture/import/image/*", async (route) => {
    imageRequests++;
    if (route.request().url().endsWith("/3")) await imageHeld;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/fixture/import/commit", async (route) => {
    commits++;
    await commitHeld;
    await route.fulfill({ status: 204 });
  });
  try {
    await sendFromPhone(page);
    await page
      .getByRole("combobox", { name: "保存到游戏" })
      .selectOption("1868140");
    await page
      .getByRole("button", { name: "保存完整图文", exact: true })
      .click();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String((2 / 3) * 100),
    );
    await expect(page.getByRole("dialog")).toContainText("正在下载图片 2/3");
    expect(imageRequests).toBe(3); // The fourth HTML image repeats the first URL.
    expect(commits).toBe(0);
    expect(await publication(page)).toBeNull();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "导入公开攻略", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "分享链接" })).toHaveValue(
      share,
    );
    await expect(
      page.getByRole("combobox", { name: "保存到游戏" }),
    ).toHaveValue("1868140");
    await expect(page.getByRole("dialog")).toContainText("正在下载图片 2/3");
    expect(imageRequests).toBe(3);
    releaseImage();
    await expect(page.getByRole("dialog")).toContainText(
      "正在保存完整离线版本",
    );
    await expect(page.locator("[data-native-progress]")).toHaveAttribute(
      "data-native-progress",
      "100",
    );
    const cancel = page.getByRole("button", { name: "取消导入", exact: true });
    await expect(cancel).toHaveClass(/Disabled/);
    await cancel.click();
    expect(await publication(page)).toBeNull();
    releaseCommit();
    await expect(page.getByRole("dialog")).toContainText(
      "正文和图片已完整保存",
    );
    expect(commits).toBe(1);
    expect((await publication(page)).identity).toEqual({
      appId: "1868140",
      guideId: "heybox-249c72219fed",
    });
    expect(
      (await events(page)).filter((event) => event.startsWith("discard:")),
    ).toHaveLength(1);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("button", { name: "导入公开攻略", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "正文和图片已完整保存",
    );
    expect(commits).toBe(1);
    await page.getByRole("button", { name: "立即阅读", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "指南正文" })).toBeFocused();
    const images = page.getByAltText(/^导入图片 /);
    await expect(images).toHaveCount(4);
    for (const image of await images.all()) {
      await expect(image).toHaveAttribute("src", /^blob:/);
      await image.evaluate(async (element: HTMLImageElement) => {
        await element.decode();
      });
      expect(
        await image.evaluate(
          (element: HTMLImageElement) => element.naturalWidth,
        ),
      ).toBe(96);
    }
  } finally {
    releaseImage();
    releaseCommit();
  }
});

test("a partial image failure and a canceled retry never publish; the next retry reuses saved images", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/fixture/import/image/2", async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, body: "图片请求失败（测试注入）" });
    } else {
      await held;
      await route.fulfill({ status: 204 });
    }
  });
  try {
    await sendFromPhone(page);
    await page
      .getByRole("button", { name: "保存完整图文", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "图片仅保存 2/3，尚未完整离线",
    );
    expect(await publication(page)).toBeNull();
    await page.getByRole("button", { name: "重试导入", exact: true }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String((2 / 3) * 100),
    );
    await page.getByRole("button", { name: "取消导入", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("正在取消");
    await expect(
      page.getByRole("button", { name: "取消导入", exact: true }),
    ).toHaveClass(/Disabled/);
    expect(await publication(page)).toBeNull();
    release();
    await expect(page.getByRole("dialog")).toContainText(
      "已取消，原有离线版本保留",
    );
    expect(await publication(page)).toBeNull();
    let history = await events(page);
    expect(history.filter((event) => event.startsWith("commit:"))).toEqual([]);
    expect(
      history.filter((event) => event.startsWith("discard:")),
    ).toHaveLength(2);
    await page
      .getByRole("button", { name: "保存完整图文", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "正文和图片已完整保存",
    );
    expect(requests).toBe(2);
    history = await events(page);
    expect(history.filter((event) => event.startsWith("reuse:"))).toHaveLength(
      5,
    );
    expect(history.filter((event) => event.startsWith("commit:"))).toHaveLength(
      1,
    );
    expect(
      history.filter((event) => event.startsWith("discard:")),
    ).toHaveLength(3);
    expect((await publication(page)).identity.guideId).toBe(
      "heybox-249c72219fed",
    );
  } finally {
    release();
  }
});
