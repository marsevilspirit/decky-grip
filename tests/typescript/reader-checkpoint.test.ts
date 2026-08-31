import { describe, expect, it } from "vitest";

import { ReaderCheckpoint } from "../../src/reader/checkpoint";

describe("ReaderCheckpoint", () => {
  it("opens only after restore settles or an intended scroll occurs", () => {
    const checkpoint = new ReaderCheckpoint();

    expect(checkpoint.canPersist).toBe(false);
    checkpoint.intendScroll();
    expect(checkpoint.canPersist).toBe(false);
    checkpoint.didScroll();
    expect(checkpoint.canPersist).toBe(true);

    checkpoint.block();
    checkpoint.didScroll();
    expect(checkpoint.canPersist).toBe(false);
    checkpoint.settle();
    expect(checkpoint.canPersist).toBe(true);
  });
});
