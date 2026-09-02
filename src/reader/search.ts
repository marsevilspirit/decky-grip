import { normalizeAnchorText } from "./anchor";
import type { DownloadedGuide } from "./types";

// ponytail: cap rendered result buttons; the UI reports truncation and a
// narrower query exposes later matches without adding pagination state.
const MAX_GUIDE_SEARCH_RESULTS = 200;
const SNIPPET_CONTEXT_CHARS = 36;
const WHITESPACE = /\s/u;
const TEXT_BOUNDARY_TAGS = new Set([
  "BLOCKQUOTE",
  "BR",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

export type GuideSearchMatchKind = "guide-title" | "section-title" | "body";

interface GuideSearchSection {
  readonly sectionId: string;
  readonly title: string;
  readonly titleText: string;
  readonly bodyText: string;
}

export interface GuideSearchIndex {
  readonly guideTitle: string;
  readonly guideTitleText: string;
  readonly sections: readonly GuideSearchSection[];
}

export interface GuideSearchResult {
  readonly sectionId: string | null;
  readonly title: string;
  readonly kind: GuideSearchMatchKind;
  readonly occurrence: number;
  readonly snippet: string;
}

export interface GuideSearchResponse {
  readonly matches: readonly GuideSearchResult[];
  readonly truncated: boolean;
}

type VisibleTextVisitor = (text: string, node: Text | null) => boolean | void;

function visitVisibleText(node: Node, visitor: VisibleTextVisitor): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return visitor(node.textContent ?? "", node as Text) !== false;
  }
  const separatesText =
    node.nodeType === Node.ELEMENT_NODE &&
    TEXT_BOUNDARY_TAGS.has((node as Element).tagName);
  if (separatesText && visitor(" ", null) === false) {
    return false;
  }
  for (const child of node.childNodes) {
    if (!visitVisibleText(child, visitor)) {
      return false;
    }
  }
  return !separatesText || visitor(" ", null) !== false;
}

function visibleText(node: Node): string {
  const parts: string[] = [];
  visitVisibleText(node, (text) => {
    parts.push(text);
  });
  return normalizeAnchorText(parts.join(""));
}

function fragmentText(template: HTMLTemplateElement, html: string): string {
  template.innerHTML = html;
  return visibleText(template.content);
}

function literalExpression(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function snippet(text: string, start: number, length: number): string {
  let from = Math.max(0, start - SNIPPET_CONTEXT_CHARS);
  let to = Math.min(text.length, start + length + SNIPPET_CONTEXT_CHARS);
  if (
    from > 0 &&
    isLowSurrogate(text.charCodeAt(from)) &&
    isHighSurrogate(text.charCodeAt(from - 1))
  ) {
    from -= 1;
  }
  if (
    to < text.length &&
    isHighSurrogate(text.charCodeAt(to - 1)) &&
    isLowSurrogate(text.charCodeAt(to))
  ) {
    to += 1;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

function appendMatches(
  matches: GuideSearchResult[],
  query: string,
  text: string,
  result: Omit<GuideSearchResult, "occurrence" | "snippet">,
): boolean {
  let occurrence = 0;
  for (const match of text.matchAll(literalExpression(query))) {
    matches.push({
      ...result,
      occurrence,
      snippet: snippet(text, match.index, match[0].length),
    });
    occurrence += 1;
    if (matches.length > MAX_GUIDE_SEARCH_RESULTS) {
      return true;
    }
  }
  return false;
}

export function buildGuideSearchIndex(
  guide: Pick<DownloadedGuide, "title" | "sections">,
): GuideSearchIndex {
  const template = document.createElement("template");
  return {
    guideTitle: guide.title,
    guideTitleText: normalizeAnchorText(guide.title),
    sections: guide.sections.map((section) => ({
      sectionId: section.id,
      title: section.title,
      titleText: normalizeAnchorText(section.title),
      bodyText: fragmentText(template, section.html),
    })),
  };
}

export function searchGuideIndex(
  index: GuideSearchIndex,
  query: string,
): GuideSearchResponse {
  const needle = normalizeAnchorText(query);
  if (!needle) {
    return { matches: [], truncated: false };
  }

  const matches: GuideSearchResult[] = [];
  let truncated = appendMatches(matches, needle, index.guideTitleText, {
    sectionId: null,
    title: index.guideTitle,
    kind: "guide-title",
  });
  for (const section of index.sections) {
    if (truncated) {
      break;
    }
    truncated = appendMatches(matches, needle, section.titleText, {
      sectionId: section.sectionId,
      title: section.title,
      kind: "section-title",
    });
    if (!truncated) {
      truncated = appendMatches(matches, needle, section.bodyText, {
        sectionId: section.sectionId,
        title: section.title,
        kind: "body",
      });
    }
  }
  return {
    matches: matches.slice(0, MAX_GUIDE_SEARCH_RESULTS),
    truncated,
  };
}

interface DomPoint {
  readonly node: Text;
  readonly offset: number;
}

function rangeForNormalizedOffsets(
  root: Node,
  start: number,
  end: number,
): Range | null {
  let normalizedOffset = 0;
  let started = false;
  let pendingWhitespace = false;
  const points: { start: DomPoint | null; end: DomPoint | null } = {
    start: null,
    end: null,
  };

  visitVisibleText(root, (text, node) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      const character = text[offset];
      if (WHITESPACE.test(character)) {
        pendingWhitespace ||= started;
        continue;
      }
      if (pendingWhitespace) {
        normalizedOffset += 1;
        pendingWhitespace = false;
      }
      if (node && normalizedOffset === start) {
        points.start = { node, offset };
      }
      normalizedOffset += 1;
      started = true;
      if (node && normalizedOffset === end) {
        points.end = { node, offset: offset + 1 };
        return false;
      }
    }
    return true;
  });

  const startPoint = points.start;
  const endPoint = points.end;
  if (!startPoint || !endPoint || !root.ownerDocument) {
    return null;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function locateGuideSearchRange(
  root: Node,
  query: string,
  occurrence: number,
): Range | null {
  const needle = normalizeAnchorText(query);
  if (!needle || !Number.isSafeInteger(occurrence) || occurrence < 0) {
    return null;
  }
  let current = 0;
  for (const match of visibleText(root).matchAll(literalExpression(needle))) {
    if (current === occurrence) {
      return rangeForNormalizedOffsets(
        root,
        match.index,
        match.index + match[0].length,
      );
    }
    current += 1;
  }
  return null;
}
