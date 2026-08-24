import { describe, expect, it } from "vitest";

import {
  normalizeGuideId,
  parseGuideRoute,
  readActiveGuide,
} from "../../src/steam/guide-route";

describe("Steam guide route identity", () => {
  it("parses only the native overlay guide route", () => {
    expect(parseGuideRoute("/app/1113000/overlay/guides")).toEqual({
      appId: "1113000",
      numericAppId: 1113000,
    });
    expect(parseGuideRoute("/app/1113000/overlay/guides/")).toEqual({
      appId: "1113000",
      numericAppId: 1113000,
    });
    expect(
      parseGuideRoute("/app/1113000/overlay/guides/3414883877"),
    ).toBeNull();
    expect(parseGuideRoute("/library/home")).toBeNull();
  });

  it("rejects ids that cannot safely be passed to Steam's numeric app API", () => {
    expect(parseGuideRoute(`/app/${"9".repeat(20)}/overlay/guides`)).toBeNull();
  });

  it("reads the selected guide only for the routed app", () => {
    const calls: number[] = [];
    const store = {
      GetSelectedGuide(appId: number) {
        calls.push(appId);
        return "3414883877";
      },
    };

    expect(readActiveGuide("/app/1113000/overlay/guides", store)).toEqual({
      appId: "1113000",
      guideId: "3414883877",
    });
    expect(calls).toEqual([1113000]);
    expect(readActiveGuide("/library/home", store)).toBeNull();
    expect(calls).toEqual([1113000]);
  });

  it("fails closed for absent or malformed selected guide ids", () => {
    expect(normalizeGuideId(null)).toBeNull();
    expect(normalizeGuideId(3414883877)).toBeNull();
    expect(normalizeGuideId("0")).toBeNull();
    expect(normalizeGuideId("3414883877")).toBe("3414883877");
    expect(
      readActiveGuide("/app/1/overlay/guides", {
        GetSelectedGuide() {
          throw new Error("not ready");
        },
      }),
    ).toBeNull();
  });
});
