import { describe, expect, it, vi } from "vitest";

import { overlayHasEditableFocus } from "../../src/hotkey/focus-guard";

function focusedWindow(composition: number, editable: boolean) {
  return {
    BrowserWindow: {
      document: {
        activeElement: {
          matches: vi.fn(() => editable),
        },
      },
    },
    CompositionStateStore: {
      GetCompositionState: () => composition,
    },
  };
}

describe("L4 editable-focus guard", () => {
  it("blocks an editor only while Steam owns overlay input", () => {
    expect(overlayHasEditableFocus(focusedWindow(2, true))).toBe(true);
    expect(overlayHasEditableFocus(focusedWindow(3, true))).toBe(true);
    expect(overlayHasEditableFocus(focusedWindow(3, false))).toBe(false);
  });

  it("ignores stale editor focus while Steam is hidden", () => {
    expect(overlayHasEditableFocus(focusedWindow(0, true))).toBe(false);
    expect(overlayHasEditableFocus(focusedWindow(1, true))).toBe(false);
    expect(overlayHasEditableFocus(focusedWindow(4, true))).toBe(false);
  });

  it("fails open when the composition state cannot be read", () => {
    expect(
      overlayHasEditableFocus({
        CompositionStateStore: {
          GetCompositionState: () => {
            throw new Error("Steam changed");
          },
        },
      }),
    ).toBe(false);
  });
});
