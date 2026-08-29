import { describe, expect, it, vi } from "vitest";

import {
  parseInstrumentedHotkeyPress,
  ReaderPerformanceTracker,
  WARM_GATE_MIN_SAMPLES,
} from "../../src/reader/performance";

const identity = { appId: "1113000", guideId: "3414883877" };

describe("physical L4 reader performance gate", () => {
  it("accepts only recent, versioned physical detection timestamps", () => {
    expect(
      parseInstrumentedHotkeyPress(
        {
          version: 1,
          button: "L4",
          sequence: 7,
          detectedAtUnixMs: 99_900,
        },
        100_000,
      ),
    ).toEqual({
      version: 1,
      button: "L4",
      sequence: 7,
      detectedAtUnixMs: 99_900,
    });
    expect(parseInstrumentedHotkeyPress("L4", 100_000)).toBeNull();
    expect(
      parseInstrumentedHotkeyPress(
        {
          version: 1,
          button: "L4",
          sequence: 8,
          detectedAtUnixMs: 60_000,
        },
        100_000,
      ),
    ).toBeNull();
  });

  it("keeps external-store snapshots stable until an update", () => {
    const tracker = new ReaderPerformanceTracker();
    const initial = tracker.getSnapshot();

    expect(tracker.getSnapshot()).toBe(initial);
    tracker.clear();
    expect(tracker.getSnapshot()).not.toBe(initial);
    expect(tracker.getSnapshot()).toBe(tracker.getSnapshot());
  });

  it("records every stage from hardware detection through restored content", () => {
    let now = 1_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    const listener = vi.fn();
    tracker.subscribe(listener);
    const trace = tracker.begin({
      version: 1,
      button: "L4",
      sequence: 4,
      detectedAtUnixMs: 900,
    });

    now = 920;
    tracker.bind(trace, identity);
    tracker.markRouteRequested(trace);
    now = 955;
    tracker.markRouteMounted(identity);
    now = 970;
    tracker.markCacheReady(identity, "memory");
    now = 1_080;
    tracker.markPositionSettled(identity, "restored");
    expect(tracker.getSnapshot().latest).toBeNull();
    now = 1_120;
    tracker.markContentFirstFrame(identity);

    expect(tracker.getSnapshot().latest).toEqual({
      sequence: 4,
      guideKey: "1113000:3414883877",
      cacheKind: "memory",
      spinnerSeen: false,
      detectedAtUnixMs: 900,
      routeRequestedMs: 20,
      routeMountedMs: 55,
      cacheReadyMs: 70,
      contentFirstFrameMs: 220,
      positionSettledMs: 180,
      positionOutcome: "restored",
      firstScreenMs: 220,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("requires 20 warm opens, P95 at most 300 ms, and zero spinners", () => {
    let now = 100_000;
    const tracker = new ReaderPerformanceTracker(() => now);

    for (let sequence = 1; sequence <= WARM_GATE_MIN_SAMPLES; sequence += 1) {
      const trace = tracker.begin({
        version: 1,
        button: "L4",
        sequence,
        detectedAtUnixMs: now,
      });
      tracker.bind(trace, identity);
      tracker.markRouteRequested(trace);
      now += 50;
      tracker.markRouteMounted(identity);
      tracker.markCacheReady(identity, "disk");
      now += sequence === WARM_GATE_MIN_SAMPLES ? 250 : 200;
      tracker.markPositionSettled(identity, "restored");
      tracker.markContentFirstFrame(identity);
      now += 1_000;
    }

    expect(tracker.getSnapshot()).toMatchObject({
      warmAttempts: WARM_GATE_MIN_SAMPLES,
      warmSamples: WARM_GATE_MIN_SAMPLES,
      warmP95Ms: 250,
      warmSpinnerCount: 0,
      warmPositionFailureCount: 0,
      gate: "pass",
    });

    const trace = tracker.begin({
      version: 1,
      button: "L4",
      sequence: 21,
      detectedAtUnixMs: now,
    });
    tracker.bind(trace, identity);
    tracker.markRouteRequested(trace);
    tracker.markRouteMounted(identity);
    tracker.markCacheReady(identity, "memory");
    tracker.markSpinner(identity);
    now += 100;
    tracker.markContentFirstFrame(identity);
    tracker.markPositionSettled(identity, "skipped");

    expect(tracker.getSnapshot()).toMatchObject({
      warmSamples: 21,
      warmSpinnerCount: 1,
      gate: "fail",
    });
  });

  it("excludes network downloads from the warm-cache gate", () => {
    let now = 10_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    const trace = tracker.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: now,
    });
    tracker.bind(trace, identity);
    tracker.markRouteRequested(trace);
    tracker.markRouteMounted(identity);
    tracker.markCacheReady(identity, "network");
    now += 900;
    tracker.markContentFirstFrame(identity);
    tracker.markPositionSettled(identity, "skipped");

    expect(tracker.getSnapshot()).toMatchObject({
      warmAttempts: 0,
      warmSamples: 0,
      warmP95Ms: null,
      gate: "collecting",
    });
  });

  it("fails the gate when a warm first screen cannot restore its position", () => {
    let now = 50_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    for (let sequence = 1; sequence <= WARM_GATE_MIN_SAMPLES; sequence += 1) {
      const trace = tracker.begin({
        version: 1,
        button: "L4",
        sequence,
        detectedAtUnixMs: now,
      });
      tracker.bind(trace, identity);
      tracker.markRouteRequested(trace);
      tracker.markRouteMounted(identity);
      tracker.markCacheReady(identity, "memory");
      now += 100;
      tracker.markContentFirstFrame(identity);
      tracker.markPositionSettled(
        identity,
        sequence === 1 ? "unavailable" : "restored",
      );
      now += 1_000;
    }

    expect(tracker.getSnapshot()).toMatchObject({
      warmPositionFailureCount: 1,
      gate: "fail",
    });
  });

  it("retains failed physical opens in the same rolling gate window", () => {
    let now = 70_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    const failed = tracker.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: now,
    });
    tracker.fail(failed, "没有可继续的指南");

    for (
      let sequence = 2;
      sequence <= WARM_GATE_MIN_SAMPLES + 1;
      sequence += 1
    ) {
      now += 1_000;
      const trace = tracker.begin({
        version: 1,
        button: "L4",
        sequence,
        detectedAtUnixMs: now,
      });
      tracker.bind(trace, identity);
      tracker.markRouteRequested(trace);
      tracker.markRouteMounted(identity);
      tracker.markCacheReady(identity, "memory");
      now += 100;
      tracker.markContentFirstFrame(identity);
      tracker.markPositionSettled(identity, "restored");
    }

    expect(tracker.getSnapshot()).toMatchObject({
      warmAttempts: WARM_GATE_MIN_SAMPLES + 1,
      warmSamples: WARM_GATE_MIN_SAMPLES,
      warmOpenFailureCount: 1,
      gate: "fail",
      latestFailure: {
        reason: "没有可继续的指南",
        guideKey: null,
      },
    });
  });

  it("starts the gate after one failure and nineteen warm successes", () => {
    let now = 80_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    const failed = tracker.begin({
      version: 1,
      button: "L4",
      sequence: 1,
      detectedAtUnixMs: now,
    });
    tracker.fail(failed, "warm open failed");

    for (let sequence = 2; sequence <= WARM_GATE_MIN_SAMPLES; sequence += 1) {
      now += 1_000;
      const trace = tracker.begin({
        version: 1,
        button: "L4",
        sequence,
        detectedAtUnixMs: now,
      });
      tracker.bind(trace, identity);
      tracker.markRouteRequested(trace);
      tracker.markRouteMounted(identity);
      tracker.markCacheReady(identity, "memory");
      now += 100;
      tracker.markContentFirstFrame(identity);
      tracker.markPositionSettled(identity, "restored");
    }

    expect(tracker.getSnapshot()).toMatchObject({
      warmAttempts: WARM_GATE_MIN_SAMPLES,
      warmSamples: WARM_GATE_MIN_SAMPLES - 1,
      warmOpenFailureCount: 1,
      gate: "fail",
    });
  });

  it("fails after twenty warm failures without a latency sample", () => {
    const tracker = new ReaderPerformanceTracker(() => 90_000);
    for (let sequence = 1; sequence <= WARM_GATE_MIN_SAMPLES; sequence += 1) {
      const trace = tracker.begin({
        version: 1,
        button: "L4",
        sequence,
        detectedAtUnixMs: 90_000,
      });
      tracker.fail(trace, "warm open failed");
    }

    expect(tracker.getSnapshot()).toMatchObject({
      warmAttempts: WARM_GATE_MIN_SAMPLES,
      warmSamples: 0,
      warmP95Ms: null,
      warmOpenFailureCount: WARM_GATE_MIN_SAMPLES,
      gate: "fail",
    });
  });

  it("times out a physical open that never reaches a terminal first screen", () => {
    vi.useFakeTimers();
    let now = 90_000;
    const tracker = new ReaderPerformanceTracker(() => now);
    tracker.begin({
      version: 1,
      button: "L4",
      sequence: 9,
      detectedAtUnixMs: now,
    });

    now += 15_000;
    vi.advanceTimersByTime(15_000);

    expect(tracker.getSnapshot()).toMatchObject({
      warmOpenFailureCount: 1,
      latestFailure: {
        failedAtMs: 15_000,
        reason: "首屏在 15 秒内未完成",
      },
    });
    vi.useRealTimers();
  });
});
