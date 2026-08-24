import { describe, expect, it } from "vitest";

import {
  extractGuideScrollSnapshots,
  guideScrollTopKey,
  MAX_SCROLL_TOP,
  mergeGuideScrollSnapshot,
  readGuideScrollSnapshot,
} from "../../src/steam/location-state";

describe("Steam guide location state", () => {
  it("extracts only verified guide scroll keys", () => {
    expect(
      extractGuideScrollSnapshots({
        OverlayGuide_3414883877ScrollTop_HistoryValue: 5561.3335,
        OverlayGuide_3414883877ScrollLeft_HistoryValue: 0,
        OverlayGuide_badScrollTop_HistoryValue: 100,
        OverlayGuide_9ScrollTop_HistoryValue: Number.NaN,
        unrelated: 42,
      }),
    ).toEqual([{ guideId: "3414883877", scrollTop: 5561.3335 }]);
  });

  it("reads only the explicitly active guide", () => {
    const locationState = {
      OverlayGuide_10ScrollTop_HistoryValue: 100,
      OverlayGuide_11ScrollTop_HistoryValue: 200,
    };

    expect(readGuideScrollSnapshot(locationState, "11")).toEqual({
      guideId: "11",
      scrollTop: 200,
    });
    expect(readGuideScrollSnapshot(locationState, "12")).toBeNull();
  });

  it("treats unsupported state as unreadable", () => {
    expect(extractGuideScrollSnapshots(null)).toEqual([]);
    expect(extractGuideScrollSnapshots([])).toEqual([]);
    expect(readGuideScrollSnapshot("state", "1")).toBeNull();
  });

  it("refuses to merge into unsupported state instead of discarding it", () => {
    for (const locationState of [[], "state", 42, true]) {
      expect(() =>
        mergeGuideScrollSnapshot(locationState, {
          guideId: "3414883877",
          scrollTop: 12,
        }),
      ).toThrow(TypeError);
    }
  });

  it("allows an absent location state to start a new state object", () => {
    expect(
      mergeGuideScrollSnapshot(null, {
        guideId: "3414883877",
        scrollTop: 12,
      }).state,
    ).toEqual({
      OverlayGuide_3414883877ScrollTop_HistoryValue: 12,
    });
  });

  it("merges without mutating unrelated state", () => {
    const original = { keep: "value" };
    const result = mergeGuideScrollSnapshot(original, {
      guideId: "3414883877",
      scrollTop: 5561.3335,
    });

    expect(result.changed).toBe(true);
    expect(result.state).toEqual({
      keep: "value",
      OverlayGuide_3414883877ScrollTop_HistoryValue: 5561.3335,
    });
    expect(original).toEqual({ keep: "value" });
  });

  it("returns the original object when the value is unchanged", () => {
    const state = {
      [guideScrollTopKey("3414883877")]: 12,
    };
    const result = mergeGuideScrollSnapshot(state, {
      guideId: "3414883877",
      scrollTop: 12,
    });

    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it("shares the backend scroll boundary", () => {
    expect(
      mergeGuideScrollSnapshot({}, { guideId: "1", scrollTop: MAX_SCROLL_TOP })
        .changed,
    ).toBe(true);
    expect(() =>
      mergeGuideScrollSnapshot(
        {},
        {
          guideId: "1",
          scrollTop: MAX_SCROLL_TOP + 1,
        },
      ),
    ).toThrow(TypeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid scrollTop: %s",
    (scrollTop) => {
      expect(() =>
        mergeGuideScrollSnapshot({}, { guideId: "1", scrollTop }),
      ).toThrow(TypeError);
    },
  );

  it("fails closed around hostile state objects", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("blocked");
        },
      },
    );

    expect(extractGuideScrollSnapshots(hostile)).toEqual([]);
    expect(() =>
      mergeGuideScrollSnapshot(hostile, { guideId: "1", scrollTop: 1 }),
    ).toThrow(TypeError);
  });
});
