import type { ReaderPosition } from "./types";

const MAX_ANCHOR_TEXT = 500;

export interface CapturedReaderPosition {
  scrollTop: number;
  sectionId: string | null;
  anchorText: string | null;
  anchorOffset: number;
}

export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textNodes(root: HTMLElement): Text[] {
  const document = root.ownerDocument;
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(root, showText);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push(node as Text);
    }
  }
  return nodes;
}

function textRect(node: Text): DOMRect {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

export function captureReaderPosition(
  scroller: HTMLElement,
  content: HTMLElement,
): CapturedReaderPosition {
  const viewport = scroller.getBoundingClientRect();
  for (const node of textNodes(content)) {
    const normalized = normalizeAnchorText(node.textContent ?? "");
    if (!normalized) {
      continue;
    }
    const rect = textRect(node);
    if (rect.bottom <= viewport.top + 1 || rect.top >= viewport.bottom - 1) {
      continue;
    }
    const section = node.parentElement?.closest<HTMLElement>(
      "[data-guide-section-id]",
    );
    return {
      scrollTop: scroller.scrollTop,
      sectionId: section?.dataset.guideSectionId ?? null,
      anchorText: normalized.slice(0, MAX_ANCHOR_TEXT),
      anchorOffset: rect.top - viewport.top,
    };
  }

  return {
    scrollTop: scroller.scrollTop,
    sectionId: null,
    anchorText: null,
    anchorOffset: 0,
  };
}

function matchesAnchor(node: Text, anchorText: string): boolean {
  const normalized = normalizeAnchorText(node.textContent ?? "");
  return (
    normalized === anchorText ||
    (anchorText.length === MAX_ANCHOR_TEXT && normalized.startsWith(anchorText))
  );
}

export function closestAnchorScrollTop(
  candidates: number[],
  fallbackScrollTop: number,
): number | null {
  let closest: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - fallbackScrollTop);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

export function restoreReaderPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  position: ReaderPosition,
): number {
  const maxScrollTop = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight,
  );
  scroller.scrollTop = Math.min(position.scrollTop, maxScrollTop);

  if (!position.anchorText) {
    return scroller.scrollTop;
  }

  const section = position.sectionId
    ? ([
        ...content.querySelectorAll<HTMLElement>("[data-guide-section-id]"),
      ].find(
        (element) => element.dataset.guideSectionId === position.sectionId,
      ) ?? content)
    : content;
  const viewport = scroller.getBoundingClientRect();
  const candidateScrollTops = textNodes(section)
    .filter((candidate) => matchesAnchor(candidate, position.anchorText!))
    .map((candidate) => {
      const rect = textRect(candidate);
      return (
        scroller.scrollTop + rect.top - viewport.top - position.anchorOffset
      );
    });
  const anchoredScrollTop = closestAnchorScrollTop(
    candidateScrollTops,
    position.scrollTop,
  );
  if (anchoredScrollTop === null) {
    return scroller.scrollTop;
  }

  scroller.scrollTop = Math.max(0, Math.min(anchoredScrollTop, maxScrollTop));
  return scroller.scrollTop;
}
