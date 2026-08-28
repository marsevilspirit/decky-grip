import {
  normalizeAnchorText,
  type CapturedReaderPosition,
} from "../reader/anchor";

const MAX_ANCHOR_TEXT = 500;
const SECTION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function sectionIdFor(node: Text, root: HTMLElement): string | null {
  let element = node.parentElement;
  while (element && element !== root) {
    const sectionId =
      element.dataset.guideSectionId ?? element.getAttribute("id");
    if (sectionId && SECTION_ID_PATTERN.test(sectionId)) {
      return sectionId;
    }
    element = element.parentElement;
  }
  return null;
}

function textNodes(root: HTMLElement): Text[] {
  const document = root.ownerDocument;
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(root, showText);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 3) {
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

/**
 * Resolve a native Steam pixel bookmark into text while the same native DOM is
 * still mounted. The target pixel is never applied to the independent reader.
 */
export function captureNativeReaderHandoff(
  scroller: HTMLElement,
  targetScrollTop: number,
): CapturedReaderPosition | null {
  if (!Number.isFinite(targetScrollTop) || targetScrollTop < 0) {
    return null;
  }

  const maxScrollTop = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight,
  );
  const target = Math.min(targetScrollTop, maxScrollTop);
  const probeOffset = Math.max(32, Math.min(scroller.clientHeight * 0.12, 96));
  const probe = target + probeOffset;
  const viewport = scroller.getBoundingClientRect();
  let best:
    | {
        node: Text;
        contentTop: number;
        distance: number;
      }
    | undefined;

  for (const node of textNodes(scroller)) {
    const normalized = normalizeAnchorText(node.textContent ?? "");
    if (!normalized) {
      continue;
    }
    const rect = textRect(node);
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const contentTop = scroller.scrollTop + rect.top - viewport.top;
    const contentBottom = scroller.scrollTop + rect.bottom - viewport.top;
    const distance =
      probe < contentTop
        ? contentTop - probe
        : probe > contentBottom
          ? probe - contentBottom
          : 0;
    if (!best || distance < best.distance) {
      best = { node, contentTop, distance };
    }
    if (distance === 0) {
      break;
    }
  }

  if (!best) {
    return null;
  }
  const anchorText = normalizeAnchorText(best.node.textContent ?? "").slice(
    0,
    MAX_ANCHOR_TEXT,
  );
  return {
    scrollTop: target,
    sectionId: sectionIdFor(best.node, scroller),
    anchorText,
    anchorOffset: best.contentTop - target,
  };
}
