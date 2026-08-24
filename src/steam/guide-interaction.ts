export function isGuideScrollIntent(
  event: Event,
  scrollerElement: HTMLElement,
): boolean {
  return (
    event.type === "wheel" ||
    event.type === "touchmove" ||
    event.type === "keydown" ||
    (event.type === "pointermove" && (event as PointerEvent).buttons !== 0) ||
    (event.type === "pointerdown" && event.target === scrollerElement)
  );
}
