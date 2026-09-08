// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858"}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractHeyboxArticle,
  parseHeyboxUrl,
  renderHeyboxArticle,
} from "../../src/import/heybox";

const sourceUrl = "https://www.xiaoheihe.cn/app/bbs/link/8a79701fa858";
const imageUrl =
  "https://imgheybox.max-c.com/web/bbs/2025/04/09/example/thumb.jpeg?imageMogr2/format/webp";

// Synthetic public-DOM-shaped fixtures, not Steam Deck acceptance evidence.
function fixture(content: string): Document {
  const document = new DOMParser().parseFromString(
    `
    <div class="post__container">
      <div class="section-title__content"> 示例攻略 </div>
      <div class="link-user__username"> 示例作者 </div>
      <div class="post__content"><div class="hb-article">${content}</div></div>
      <div class="comment-list">不应保存的评论</div>
    </div>`,
    "text/html",
  );
  return document;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Xiaoheihe import", () => {
  it("normalizes canonical, mobile and copied share links without tracking", () => {
    const expected = { guideId: "heybox-8a79701fa858", sourceUrl };
    expect(parseHeyboxUrl(sourceUrl)).toEqual(expected);
    expect(
      parseHeyboxUrl(
        `推荐攻略：https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_session_id=private&link_id=8a79701fa858&h_src=app`,
      ),
    ).toEqual(expected);
    expect(
      parseHeyboxUrl(
        "https://www.xiaoheihe.cn/bbs/post_share?link_id=8a79701fa858&h_camp=link",
      ),
    ).toEqual(expected);
    expect(parseHeyboxUrl(`${sourceUrl}#grip-import-123`)).toEqual(expected);
  });

  it.each([
    sourceUrl.replace("https:", "http:"),
    sourceUrl.replace("www.", "evil."),
    sourceUrl.replace(".cn/", ".cn.evil.test/"),
    sourceUrl.replace(".cn/", ".cn:8443/"),
    sourceUrl.replace("https://", "https://user:password@"),
    sourceUrl.replace("8a79701fa858", "../../etc/passwd"),
    sourceUrl.replace("8a79701fa858", "123"),
    sourceUrl.replace("8a79701fa858", "%38a79701fa858"),
    sourceUrl.replace("/app/", "\\app/"),
    "https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=8a79701fa858&link_id=249c72219fed",
    `${sourceUrl} https://example.com/`,
    "只有分享文字，没有链接",
  ])("rejects unsupported or ambiguous URL %s", (input) => {
    expect(() => parseHeyboxUrl(input)).toThrow();
  });

  it("keeps screenshot captions with their images instead of splitting chapters", () => {
    const result = extractHeyboxArticle(
      fixture(`<h2>配装</h2><div class="img"><img src="${imageUrl}"></div>
        <h4 class="img-desc">这张图的说明</h4><p>下一套配置</p>
        <h4>真正的章节</h4><p>正文</p>`),
      sourceUrl,
    );
    expect(result.sections.map((section) => section.title)).toEqual([
      "配装",
      "真正的章节",
    ]);
    expect(result.sections[0].html).toContain("<h4>这张图的说明</h4>");
    expect(result.sections[0].html).toContain("data-grip-image-url");
    expect(result.sections[0].html).toContain("下一套配置");
  });

  it("keeps chapters, body images and table cells but removes site cards and executable markup", () => {
    const doc = fixture(`
      <p>前言 <strong>注意事项</strong></p>
      <h2>合成路线</h2>
      <p style="height:9999px" onclick="evil()">有效正文 <a href="javascript:evil()">链接文字</a></p>
      <div class="img-media" style="height:300px"><img class="img-item" src="${imageUrl}" onerror="evil()"></div>
      <div class="com-game-card"><img src="https://evil.test/icon">不应保存的商品卡</div>
      <script>不应保存的脚本</script><aside>不应保存的广告</aside>
      <h4>属性表格</h4>
      <table><thead><tr><th colspan="2">能力</th></tr></thead><tbody><tr><td rowspan="2"><img class="img-item" src="${imageUrl}"></td><td>耐力</td></tr><tr><td>力量</td></tr></tbody></table>
      <div class="comment-list">不应保存的内嵌评论</div>`);
    const original = doc.body.innerHTML;
    const result = extractHeyboxArticle(doc, sourceUrl);
    expect(result).toMatchObject({
      guideId: "heybox-8a79701fa858",
      sourceUrl,
      title: "示例攻略",
      author: "示例作者",
      imageUrls: [imageUrl],
    });
    expect(result.sections.map(({ id, title }) => [id, title])).toEqual([
      ["1", "正文"],
      ["2", "合成路线"],
      ["3", "属性表格"],
    ]);
    const output = new DOMParser().parseFromString(
      result.sections.map((s) => s.html).join(""),
      "text/html",
    );
    expect(output.querySelectorAll("img[data-grip-image-url]")).toHaveLength(2);
    expect(
      output.querySelectorAll(
        "img[src],script,aside,[onclick],[onerror],[style]",
      ),
    ).toHaveLength(0);
    expect(output.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(output.querySelector("td")?.getAttribute("rowspan")).toBe("2");
    expect(output.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(output.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(output.body.textContent).not.toContain("不应保存");
    expect(doc.body.innerHTML).toBe(original);
  });

  it("retains all screenshot-only content including images inside headings", () => {
    const doc = fixture(
      Array.from(
        { length: 15 },
        (_, index) =>
          `<h4>截图 ${index + 1}</h4><div class="img"><img class="img-item" src="${imageUrl}&n=${index}"></div>`,
      ).join("") + `<h4><img src="${imageUrl}"></h4>`,
    );
    const result = extractHeyboxArticle(doc, sourceUrl);
    expect(result.imageUrls).toHaveLength(16);
    expect(result.sections).toHaveLength(15);
    expect(
      result.sections
        .map((s) => s.html)
        .join("")
        .match(/<img /g) ?? [],
    ).toHaveLength(16);
  });

  it.each([
    "",
    "https://evil.test/image.png",
    "http://imgheybox.max-c.com/bbs/image.png",
    "https://user@imgheybox.max-c.com/bbs/image.png",
    "https://imgheybox.max-c.com:8080/bbs/image.png",
    "https://imgheybox.max-c.com/avatar/image.png",
  ])("does not silently drop an unloaded or unsupported image %s", (source) => {
    expect(() =>
      extractHeyboxArticle(
        fixture(`<p>正文</p><img class="img-item" src="${source}">`),
        sourceUrl,
      ),
    ).toThrow();
  });

  it("fails incomplete metadata, unsupported embedded media and excessive payloads", () => {
    const incomplete = fixture("<p>正文</p>");
    incomplete.querySelector(".link-user__username")?.remove();
    expect(() => extractHeyboxArticle(incomplete, sourceUrl)).toThrow(/作者/);
    expect(() =>
      extractHeyboxArticle(
        fixture("<p>正文</p><video src='https://example.com/a.mp4'></video>"),
        sourceUrl,
      ),
    ).toThrow(/视频/);
    expect(() =>
      extractHeyboxArticle(
        fixture(`<p>${"字".repeat(1_500_000)}</p>`),
        sourceUrl,
      ),
    ).toThrow(/4 MiB/);
  });

  it("rejects body SVG or canvas but safely ignores graphics inside removed game cards", () => {
    for (const tag of ["svg", "canvas"]) {
      expect(() =>
        extractHeyboxArticle(
          fixture(`<p>正文</p><${tag}></${tag}>`),
          sourceUrl,
        ),
      ).toThrow(/图形/);
      const result = extractHeyboxArticle(
        fixture(
          `<p>正文</p><div class="com-game-card"><${tag}></${tag}></div>`,
        ),
        sourceUrl,
      );
      expect(result.sections[0].html).toBe("<p>正文</p>");
    }
  });

  it("scrolls lazy images, waits for stable content and preserves the full image manifest", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    document.body.innerHTML = fixture(
      `<h4>截图</h4><img class="img-item" src="">`,
    ).body.innerHTML;
    const image = document.querySelector<HTMLImageElement>(".img-item")!;
    const scroll = vi
      .spyOn(image, "scrollIntoView")
      .mockImplementation(() => image.setAttribute("src", imageUrl));
    const pending = renderHeyboxArticle(sourceUrl);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).imageUrls).toEqual([imageUrl]);
    expect(scroll).toHaveBeenCalled();
  });

  it("accepts settled image URLs without a per-image rendering delay", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    document.body.innerHTML = fixture(
      Array.from(
        { length: 61 },
        (_, index) => `<img src="${imageUrl}&n=${index}">`,
      ).join(""),
    ).body.innerHTML;
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const completed = vi.fn();
    const pending = renderHeyboxArticle(sourceUrl).then(completed);
    await vi.advanceTimersByTimeAsync(400);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][0].imageUrls).toHaveLength(61);
    expect(scroll).not.toHaveBeenCalled();
    await pending;
  });

  it("restarts stability checks when another lazy image is added", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    document.body.innerHTML = fixture(
      `<p>正文</p><img src="${imageUrl}">`,
    ).body.innerHTML;
    const completed = vi.fn();
    const pending = renderHeyboxArticle(sourceUrl).then(completed);
    await vi.advanceTimersByTimeAsync(200);
    const image = document.createElement("img");
    document.querySelector(".hb-article")!.appendChild(image);
    const scroll = vi.spyOn(image, "scrollIntoView").mockImplementation(() => {
      setTimeout(() => image.setAttribute("src", `${imageUrl}&late=1`), 200);
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][0].imageUrls).toEqual([
      imageUrl,
      `${imageUrl}&late=1`,
    ]);
    expect(scroll).toHaveBeenCalledOnce();
    await pending;
  });

  it("stops reading if the temporary import page navigates away while waiting", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    const pending = renderHeyboxArticle(sourceUrl);
    const rejected = expect(pending).rejects.toThrow();
    window.history.replaceState(
      null,
      "",
      "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed",
    );
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
  });

  it("times out instead of accepting a permanently missing lazy image", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    document.body.innerHTML = fixture(
      '<p>正文</p><img class="img-item" src="">',
    ).body.innerHTML;
    const pending = renderHeyboxArticle(sourceUrl);
    const rejected = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
  });

  it("does not accept stable DOM when the article metadata is missing", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", sourceUrl);
    document.body.innerHTML = fixture("<p>正文</p>").body.innerHTML;
    document.querySelector(".section-title__content")?.remove();
    const pending = renderHeyboxArticle(sourceUrl);
    const rejected = expect(pending).rejects.toThrow(/标题/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });
});
