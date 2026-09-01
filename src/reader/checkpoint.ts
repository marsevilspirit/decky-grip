const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

export function isReaderScrollInteraction(
  event: Event,
  scroller: EventTarget,
): boolean {
  return (
    event.type === "wheel" ||
    event.type === "touchmove" ||
    (event.type === "pointerdown" && event.target === scroller) ||
    (event.type === "keydown" && SCROLL_KEYS.has((event as KeyboardEvent).key))
  );
}

export function readerRestoreCanSettle(
  allSectionsRendered: boolean,
  hasAnchor: boolean,
  anchorReady: boolean,
  pixelFallbackReady: boolean,
): boolean {
  return (
    allSectionsRendered &&
    (hasAnchor ? anchorReady || pixelFallbackReady : pixelFallbackReady)
  );
}

export class ReaderCheckpoint {
  private safe = false;
  private scrollIntended = false;

  get canPersist(): boolean {
    return this.safe;
  }

  block(): void {
    this.safe = false;
    this.scrollIntended = false;
  }

  settle(): void {
    this.safe = true;
    this.scrollIntended = false;
  }

  intendScroll(): void {
    this.scrollIntended = true;
  }

  didScroll(): void {
    if (this.scrollIntended) {
      this.safe = true;
    }
    this.scrollIntended = false;
  }
}
