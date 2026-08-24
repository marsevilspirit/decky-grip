import { describe, expect, it } from "vitest";

import { isGuideScrollIntent } from "../../src/steam/guide-interaction";

function event(
  type: string,
  options: { buttons?: number; target?: EventTarget | null } = {},
): Event {
  return { type, ...options } as unknown as Event;
}

describe("Steam guide interaction classification", () => {
  const scroller = {} as HTMLElement;
  const child = {} as HTMLElement;

  it.each(["wheel", "touchmove", "keydown"])(
    "treats %s as scroll intent",
    (type) => {
      expect(isGuideScrollIntent(event(type), scroller)).toBe(true);
    },
  );

  it("requires a pressed pointer button for pointer movement", () => {
    expect(
      isGuideScrollIntent(event("pointermove", { buttons: 0 }), scroller),
    ).toBe(false);
    expect(
      isGuideScrollIntent(event("pointermove", { buttons: 1 }), scroller),
    ).toBe(true);
  });

  it("only treats a pointer press on the scroller itself as scroll intent", () => {
    expect(
      isGuideScrollIntent(event("pointerdown", { target: scroller }), scroller),
    ).toBe(true);
    expect(
      isGuideScrollIntent(event("pointerdown", { target: child }), scroller),
    ).toBe(false);
  });

  it("does not treat a touch tap as scroll intent", () => {
    expect(isGuideScrollIntent(event("touchstart"), scroller)).toBe(false);
  });
});
