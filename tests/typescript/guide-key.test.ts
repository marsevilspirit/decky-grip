import { describe, expect, it } from "vitest";

import { makeGuideKey, splitGuideKey } from "../../src/steam/guide-key";

describe("guide keys", () => {
  it("keeps ids as decimal strings", () => {
    const guideId = "90071992547409931234";

    expect(makeGuideKey({ appId: "1113000", guideId })).toBe(
      `1113000:${guideId}`,
    );
    expect(splitGuideKey(`1113000:${guideId}`)).toEqual({
      appId: "1113000",
      guideId,
    });
  });

  it.each(["", "0", "-1", "12.5", "abc", "1/../../2"])(
    "rejects invalid ids: %s",
    (invalidId) => {
      expect(() =>
        makeGuideKey({ appId: "1113000", guideId: invalidId }),
      ).toThrow(TypeError);
    },
  );

  it("uses the same 20-digit id boundary as the backend", () => {
    expect(makeGuideKey({ appId: "1", guideId: "9".repeat(20) })).toBe(
      `1:${"9".repeat(20)}`,
    );
    expect(() => makeGuideKey({ appId: "1", guideId: "9".repeat(21) })).toThrow(
      TypeError,
    );
    expect(() => makeGuideKey({ appId: "9".repeat(21), guideId: "1" })).toThrow(
      TypeError,
    );
  });

  it("rejects malformed compound keys", () => {
    expect(() => splitGuideKey("1113000")).toThrow(TypeError);
    expect(() => splitGuideKey("1:2:3")).toThrow(TypeError);
  });

  it("namespaces imported articles without changing Steam keys or app ids", () => {
    const identity = { appId: "1113000", guideId: "heybox-8a79701fa858" };
    expect(splitGuideKey(makeGuideKey(identity))).toEqual(identity);
    expect(makeGuideKey({ appId: "1113000", guideId: "123" })).toBe(
      "1113000:123",
    );
    expect(() =>
      makeGuideKey({ appId: identity.guideId, guideId: "1" }),
    ).toThrow();
    for (const invalid of [
      "heybox-123",
      "heybox-8A79701FA858",
      "heybox-8a79701fa858/..",
    ])
      expect(() => makeGuideKey({ appId: "1", guideId: invalid })).toThrow();
  });
});
