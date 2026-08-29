import type { ReaderPosition } from "./types";

const MAX_ANCHOR_TEXT = 500;
const SECTION_SELECTOR = "[data-guide-section-id]";

export interface CapturedReaderPosition {
  scrollTop: number;
  sectionId: string | null;
  anchorText: string | null;
  anchorOffset: number;
}

interface IndexedAnchor {
  node: Text;
  normalized: string;
  sectionId: string | null;
}

export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function anchorKey(normalized: string): string {
  return normalized.slice(0, MAX_ANCHOR_TEXT);
}

function textRect(node: Text): DOMRect {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

function isVisible(rect: DOMRect, viewport: DOMRect): boolean {
  return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
}

/**
 * Text anchors are immutable for one rendered guide. Indexing each mounted
 * section once keeps scroll saves, image-driven restores, and TOC jumps from
 * repeatedly walking every text node in a large guide.
 */
export class ReaderAnchorIndex {
  readonly content: HTMLElement;

  private readonly anchors = new Map<string, IndexedAnchor[]>();
  private readonly entries: IndexedAnchor[] = [];
  private readonly indexedRoots = new WeakSet<HTMLElement>();
  private readonly sections = new Map<string, HTMLElement>();
  private captureCursor = 0;

  constructor(content: HTMLElement) {
    this.content = content;
    this.refresh();
  }

  get size(): number {
    return this.entries.length;
  }

  refresh(): number {
    let indexed = 0;
    let sawSection = false;
    for (const section of this.content.querySelectorAll<HTMLElement>(
      SECTION_SELECTOR,
    )) {
      sawSection = true;
      const sectionId = section.dataset.guideSectionId;
      if (sectionId) {
        this.sections.set(sectionId, section);
      }
      if (!this.indexedRoots.has(section)) {
        indexed += this.indexRoot(section, sectionId ?? null);
      }
    }

    // This fallback preserves the helper's public behavior for callers whose
    // content is not divided into GRIP sections.
    if (!sawSection && !this.indexedRoots.has(this.content)) {
      indexed += this.indexRoot(this.content, null);
    }
    return indexed;
  }

  sectionElement(sectionId: string): HTMLElement | null {
    return this.sections.get(sectionId) ?? null;
  }

  firstVisible(viewport: DOMRect): IndexedAnchor | null {
    if (this.entries.length === 0) {
      return null;
    }

    const start = Math.min(this.captureCursor, this.entries.length - 1);
    const startRect = textRect(this.entries[start].node);
    if (startRect.bottom <= viewport.top + 1) {
      for (let index = start + 1; index < this.entries.length; index += 1) {
        const rect = textRect(this.entries[index].node);
        if (isVisible(rect, viewport)) {
          this.captureCursor = index;
          return this.entries[index];
        }
        if (rect.top >= viewport.bottom - 1) {
          return null;
        }
      }
      return null;
    }

    let firstVisibleIndex: number | null = isVisible(startRect, viewport)
      ? start
      : null;
    for (let index = start - 1; index >= 0; index -= 1) {
      const rect = textRect(this.entries[index].node);
      if (rect.bottom <= viewport.top + 1) {
        break;
      }
      if (isVisible(rect, viewport)) {
        firstVisibleIndex = index;
      }
    }
    if (firstVisibleIndex !== null) {
      this.captureCursor = firstVisibleIndex;
      return this.entries[firstVisibleIndex];
    }

    for (let index = start + 1; index < this.entries.length; index += 1) {
      const rect = textRect(this.entries[index].node);
      if (isVisible(rect, viewport)) {
        this.captureCursor = index;
        return this.entries[index];
      }
      if (rect.top >= viewport.bottom - 1) {
        return null;
      }
    }
    return null;
  }

  candidates(anchorText: string, sectionId: string | null): IndexedAnchor[] {
    const candidates = this.anchors.get(anchorText) ?? [];
    const textMatches = candidates.filter(
      (candidate) =>
        candidate.normalized === anchorText ||
        (anchorText.length === MAX_ANCHOR_TEXT &&
          candidate.normalized.startsWith(anchorText)),
    );
    if (!sectionId) {
      return textMatches;
    }
    const sectionMatches = textMatches.filter(
      (candidate) => candidate.sectionId === sectionId,
    );
    return sectionMatches.length > 0 ? sectionMatches : textMatches;
  }

  private indexRoot(root: HTMLElement, sectionId: string | null): number {
    this.indexedRoots.add(root);
    const document = root.ownerDocument;
    const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
    const walker = document.createTreeWalker(root, showText);
    let indexed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType !== 3) {
        continue;
      }
      const text = node as Text;
      const normalized = normalizeAnchorText(text.textContent ?? "");
      if (!normalized) {
        continue;
      }
      const entry = { node: text, normalized, sectionId };
      this.entries.push(entry);
      const key = anchorKey(normalized);
      const matches = this.anchors.get(key);
      if (matches) {
        matches.push(entry);
      } else {
        this.anchors.set(key, [entry]);
      }
      indexed += 1;
    }
    return indexed;
  }
}

function anchorIndex(
  content: HTMLElement,
  existing?: ReaderAnchorIndex,
): ReaderAnchorIndex {
  const index =
    existing?.content === content ? existing : new ReaderAnchorIndex(content);
  index.refresh();
  return index;
}

export function captureReaderPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  existingIndex?: ReaderAnchorIndex,
): CapturedReaderPosition {
  const index = anchorIndex(content, existingIndex);
  const viewport = scroller.getBoundingClientRect();
  const anchor = index.firstVisible(viewport);
  if (anchor) {
    const rect = textRect(anchor.node);
    return {
      scrollTop: scroller.scrollTop,
      sectionId: anchor.sectionId,
      anchorText: anchorKey(anchor.normalized),
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
  existingIndex?: ReaderAnchorIndex,
): number {
  const maxScrollTop = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight,
  );
  scroller.scrollTop = Math.min(position.scrollTop, maxScrollTop);

  if (!position.anchorText) {
    return scroller.scrollTop;
  }

  const index = anchorIndex(content, existingIndex);
  const viewport = scroller.getBoundingClientRect();
  const candidateScrollTops = index
    .candidates(position.anchorText, position.sectionId)
    .map((candidate) => {
      const rect = textRect(candidate.node);
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
