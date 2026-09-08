import type { DownloadedGuideSection } from "../reader/types";

export interface RenderedHeyboxGuide {
  guideId: string;
  title: string;
  author: string;
  sourceUrl: string;
  sections: DownloadedGuideSection[];
  imageUrls: string[];
}

/** Accept copied share text, but never forward tracking or session parameters. */
export function parseHeyboxUrl(input: string): {
  guideId: string;
  sourceUrl: string;
} {
  const candidates = input.match(/https?:\/\/[^\s<>"'，。！？）)\]]+/gi) ?? [];
  if (candidates.length !== 1 || candidates[0].includes("\\")) {
    throw new TypeError("请粘贴一条小黑盒攻略链接或分享文字");
  }
  const url = new URL(candidates[0]);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new TypeError(
      "小黑盒攻略链接必须使用 HTTPS，且不能包含账号或自定义端口",
    );
  }
  let id: string | null = null;
  if (url.hostname === "www.xiaoheihe.cn") {
    id =
      /^\/app\/bbs\/link\/([a-f0-9]{12})\/?$/.exec(url.pathname)?.[1] ?? null;
    if (url.pathname === "/bbs/post_share") {
      id = url.searchParams.get("link_id");
    }
  } else if (
    url.hostname === "api.xiaoheihe.cn" &&
    url.pathname === "/v3/bbs/app/api/web/share"
  ) {
    id = url.searchParams.get("link_id");
  }
  if (
    !id ||
    !/^[a-f0-9]{12}$/.test(id) ||
    url.searchParams.getAll("link_id").length > 1
  ) {
    throw new TypeError("不支持的小黑盒攻略链接");
  }
  return {
    guideId: `heybox-${id}`,
    sourceUrl: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
  };
}

const NOISE = [
  "script",
  "style",
  "noscript",
  "template",
  "form",
  "button",
  "input",
  "nav",
  "aside",
  "[hidden]",
  "[aria-hidden=true]",
  ".com-game-card",
  ".com-product-card",
  ".com-goods-card",
  ".hb-ad",
  ".advertisement",
  ".comment-list",
  ".post__comments",
].join(",");

function bodyImages(article: Element): HTMLImageElement[] {
  return Array.from(article.querySelectorAll<HTMLImageElement>("img")).filter(
    (image) => !image.closest(NOISE),
  );
}

function imageSource(image: HTMLImageElement): string {
  const source = image.getAttribute("src")?.trim();
  if (!source) throw new Error("正文图片尚未加载完整，请等待加载后重试");
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "imgheybox.max-c.com" ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/(?:web\/)?bbs\//.test(url.pathname)
  ) {
    throw new Error("正文包含暂不支持的图片来源，未保存不完整攻略");
  }
  url.hash = "";
  return url.href;
}

/** Read only public article DOM; build fresh nodes so site scripts/styles never enter the reader. */
export function extractHeyboxArticle(
  document: Document,
  sourceUrl: string,
): RenderedHeyboxGuide {
  const identity = parseHeyboxUrl(sourceUrl);
  const articles = document.querySelectorAll(".hb-article");
  const article = articles[0];
  const container = article?.closest(".post__container");
  const title = container
    ?.querySelector(".section-title__content")
    ?.textContent?.trim();
  const author = container
    ?.querySelector(".link-user__username")
    ?.textContent?.trim();
  if (articles.length !== 1 || !title || !author) {
    throw new Error("未找到完整攻略正文、标题或作者，请确认链接可以公开阅读");
  }
  const imageUrls = new Set<string>();
  const allowed = new Set(
    "p div span b strong i em u s del blockquote ul ol li pre code br hr h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr th td caption colgroup col a img figure figcaption sub sup".split(
      " ",
    ),
  );
  let nodes = 0;
  const copy = (node: Node, depth = 0): Node | null => {
    if (++nodes > 200_000 || depth > 128)
      throw new Error("攻略结构过大，无法安全导入");
    if (node.nodeType === 3)
      return document.createTextNode(node.textContent ?? "");
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    if (element.matches(NOISE)) return null;
    if (element.matches("video,audio,iframe,object,embed,svg,canvas")) {
      throw new Error("这篇攻略包含暂不支持离线保存的视频、图形或嵌入内容");
    }
    const tag = element.tagName.toLowerCase();
    const result = document.createElement(allowed.has(tag) ? tag : "div");
    if (tag === "img") {
      const source = imageSource(element as HTMLImageElement);
      imageUrls.add(source);
      result.setAttribute("data-grip-image-url", source);
      result.setAttribute("alt", element.getAttribute("alt") ?? "");
      const image = element as HTMLImageElement;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        result.setAttribute("width", String(image.naturalWidth));
        result.setAttribute("height", String(image.naturalHeight));
      }
    } else if (tag === "a") {
      try {
        const href = new URL(
          element.getAttribute("href") ?? "",
          identity.sourceUrl,
        );
        if (
          href.protocol === "https:" &&
          !href.username &&
          !href.password &&
          !href.port
        ) {
          result.setAttribute("href", href.href);
        }
      } catch {
        /* Keep link text, never executable URLs. */
      }
    } else if (tag === "td" || tag === "th") {
      for (const name of ["colspan", "rowspan"]) {
        const value = element.getAttribute(name);
        if (value && /^[1-9]\d{0,2}$/.test(value))
          result.setAttribute(name, value);
      }
    }
    for (const child of Array.from(element.childNodes)) {
      const copied = copy(child, depth + 1);
      if (copied) result.appendChild(copied);
    }
    return result;
  };
  const sections: DownloadedGuideSection[] = [];
  let sectionTitle = "正文";
  let hasHeading = false;
  let body = document.createElement("div");
  const flush = () => {
    if (
      !hasHeading &&
      !body.textContent?.trim() &&
      !body.querySelector("img,table,hr")
    )
      return;
    if (sections.length >= 512) throw new Error("攻略章节过多，无法导入");
    sections.push({
      id: String(sections.length + 1),
      title: sectionTitle,
      html: body.innerHTML,
    });
    body = document.createElement("div");
  };
  // ponytail: the public article has top-level heading blocks; nested headings remain readable inline.
  for (const child of Array.from(article.childNodes)) {
    const copied = copy(child);
    if (!copied) continue;
    if (
      copied.nodeType === 1 &&
      /^H[1-6]$/.test((copied as Element).tagName) &&
      !(child as Element).classList.contains("img-desc") &&
      !(copied as Element).querySelector("img,table")
    ) {
      flush();
      sectionTitle = copied.textContent?.trim() || "章节";
      hasHeading = true;
    } else {
      body.appendChild(copied);
    }
  }
  flush();
  if (!sections.length) throw new Error("攻略正文为空，未保存");
  const result = {
    ...identity,
    title,
    author,
    sections,
    imageUrls: [...imageUrls],
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    4 * 1024 * 1024
  ) {
    throw new Error("攻略导入数据超过 4 MiB 上限");
  }
  return result;
}

/** Run only in the dedicated temporary import tab, never the user's existing browser page. */
export async function renderHeyboxArticle(
  sourceUrl: string,
): Promise<RenderedHeyboxGuide> {
  const identity = parseHeyboxUrl(sourceUrl);
  const deadline = Date.now() + 90_000;
  const assertPage = () => {
    if (parseHeyboxUrl(document.location.href).guideId !== identity.guideId) {
      throw new Error("导入页面已跳转，已停止读取");
    }
    if (Date.now() >= deadline)
      throw new Error("攻略图片加载超时，未保存不完整攻略");
  };
  const wait = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assertPage();
  };
  let previous = "";
  let stable = 0;
  for (;;) {
    assertPage();
    const article = document.querySelector(".hb-article");
    if (!article) {
      await wait();
      continue;
    }
    for (const image of bodyImages(article)) {
      // The offline downloader validates image bytes; only wake unresolved lazy URLs here.
      if (image.getAttribute("src")?.trim()) continue;
      assertPage();
      image.scrollIntoView({ block: "center", behavior: "instant" });
      await wait();
    }
    let sources: string[];
    try {
      sources = bodyImages(article).map(imageSource);
    } catch (error) {
      if (
        bodyImages(article).some((image) => !image.getAttribute("src")?.trim())
      ) {
        stable = 0;
        await wait();
        continue;
      }
      throw error;
    }
    const signature = JSON.stringify([article.textContent, sources]);
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 2) return extractHeyboxArticle(document, identity.sourceUrl);
    await wait();
  }
}
