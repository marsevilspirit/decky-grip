const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

export function canTriggerGuideScroll(event: Event): boolean {
  return (
    (event.type !== "pointermove" || (event as PointerEvent).buttons !== 0) &&
    (event.type !== "keydown" || SCROLL_KEYS.has((event as KeyboardEvent).key))
  );
}

export function isGuideScrollIntent(
  event: Event,
  scrollerElement: HTMLElement,
): boolean {
  return (
    canTriggerGuideScroll(event) &&
    (event.type === "wheel" ||
      event.type === "touchmove" ||
      event.type === "keydown" ||
      event.type === "pointermove" ||
      (event.type === "pointerdown" && event.target === scrollerElement))
  );
}
