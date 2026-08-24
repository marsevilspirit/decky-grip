export interface GuideScroller {
  readonly element: HTMLElement;
  readonly imagesComplete: boolean;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  scrollTo(scrollTop: number): void;
}

function isVisible(element: HTMLElement, ownerWindow: Window): boolean {
  const style = ownerWindow.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    (style.overflowY !== "auto" && style.overflowY !== "scroll")
  ) {
    return false;
  }

  const bounds = element.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 && element.clientHeight > 0;
}

/** Locate Steam's guide detail ScrollPanel without relying on hashed classes. */
export function findGuideScroller(document: Document): GuideScroller | null {
  const ownerWindow = document.defaultView;
  if (!ownerWindow) {
    return null;
  }

  const matches = Array.from(
    document.querySelectorAll<HTMLElement>(".Panel.Focusable"),
  ).filter(
    (element) =>
      element.isConnected &&
      element.style.scrollPaddingTop === "20px" &&
      element.style.scrollPaddingBottom === "20px" &&
      isVisible(element, ownerWindow),
  );

  if (matches.length !== 1) {
    return null;
  }

  const element = matches[0];
  return {
    element,
    get imagesComplete() {
      return Array.from(element.querySelectorAll("img")).every(
        (image) => image.complete,
      );
    },
    get clientHeight() {
      return element.clientHeight;
    },
    get scrollHeight() {
      return element.scrollHeight;
    },
    get scrollTop() {
      return element.scrollTop;
    },
    scrollTo(scrollTop: number) {
      element.scrollTo({ top: scrollTop, behavior: "auto" });
    },
  };
}
