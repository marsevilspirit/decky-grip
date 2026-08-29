import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

export const WARM_FIRST_SCREEN_TARGET_MS = 300;
export const WARM_GATE_MIN_SAMPLES = 20;
const MAX_RETAINED_SAMPLES = 50;
const MAX_EVENT_AGE_MS = 30_000;
const MAX_EVENT_CLOCK_SKEW_MS = 2_000;
const TRACE_TIMEOUT_MS = 15_000;

export interface InstrumentedHotkeyPress {
  version: 1;
  button: "L4";
  sequence: number;
  detectedAtUnixMs: number;
}

export type HotkeyPressPayload = InstrumentedHotkeyPress | "L4" | unknown;

export type ReaderCacheKind = "memory" | "disk" | "network";
export type ReaderPositionOutcome = "restored" | "skipped" | "unavailable";
export type ReaderPerformanceGate = "collecting" | "pass" | "fail";

export interface ReaderPerformanceSample {
  sequence: number;
  guideKey: string;
  cacheKind: ReaderCacheKind;
  spinnerSeen: boolean;
  detectedAtUnixMs: number;
  routeRequestedMs: number;
  routeMountedMs: number;
  cacheReadyMs: number;
  contentFirstFrameMs: number;
  positionSettledMs: number;
  positionOutcome: ReaderPositionOutcome;
  firstScreenMs: number;
}

export interface ReaderPerformanceFailure {
  sequence: number;
  guideKey: string | null;
  cacheKind: ReaderCacheKind | null;
  spinnerSeen: boolean;
  detectedAtUnixMs: number;
  failedAtMs: number;
  reason: string;
}

export interface ReaderPerformanceSnapshot {
  latest: ReaderPerformanceSample | null;
  latestFailure: ReaderPerformanceFailure | null;
  warmAttempts: number;
  warmSamples: number;
  warmP95Ms: number | null;
  warmSpinnerCount: number;
  warmPositionFailureCount: number;
  warmOpenFailureCount: number;
  targetMs: number;
  minimumSamples: number;
  gate: ReaderPerformanceGate;
}

export interface ReaderPerformanceTrace {
  readonly token: object;
}

interface MutableTrace {
  token: object;
  sequence: number;
  detectedAtUnixMs: number;
  guideKey: string | null;
  cacheKind: ReaderCacheKind | null;
  spinnerSeen: boolean;
  routeRequestedAtUnixMs: number | null;
  routeMountedAtUnixMs: number | null;
  cacheReadyAtUnixMs: number | null;
  contentFirstFrameAtUnixMs: number | null;
  positionSettledAtUnixMs: number | null;
  positionOutcome: ReaderPositionOutcome | null;
  timeout: ReturnType<typeof setTimeout>;
}

type ReaderPerformanceAttempt =
  | { kind: "success"; sample: ReaderPerformanceSample }
  | { kind: "failure"; failure: ReaderPerformanceFailure };

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function parseInstrumentedHotkeyPress(
  payload: HotkeyPressPayload,
  nowUnixMs = Date.now(),
): InstrumentedHotkeyPress | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Partial<InstrumentedHotkeyPress>;
  const sequence = finiteInteger(candidate.sequence);
  const detectedAtUnixMs = finiteInteger(candidate.detectedAtUnixMs);
  if (
    candidate.version !== 1 ||
    candidate.button !== "L4" ||
    sequence === null ||
    sequence < 1 ||
    detectedAtUnixMs === null ||
    detectedAtUnixMs < nowUnixMs - MAX_EVENT_AGE_MS ||
    detectedAtUnixMs > nowUnixMs + MAX_EVENT_CLOCK_SKEW_MS
  ) {
    return null;
  }
  return {
    version: 1,
    button: "L4",
    sequence,
    detectedAtUnixMs,
  };
}

function elapsed(start: number, end: number | null): number {
  return Math.max(0, (end ?? start) - start);
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null;
}

export class ReaderPerformanceTracker {
  private readonly traces = new Map<object, MutableTrace>();
  private readonly traceByGuide = new Map<string, object>();
  private readonly attempts: ReaderPerformanceAttempt[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: ReaderPerformanceSnapshot | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ReaderPerformanceSnapshot => {
    if (this.snapshot) {
      return this.snapshot;
    }
    const samples = this.attempts.flatMap((attempt) =>
      attempt.kind === "success" ? [attempt.sample] : [],
    );
    const failures = this.attempts.flatMap((attempt) =>
      attempt.kind === "failure" ? [attempt.failure] : [],
    );
    const warm = samples.filter((sample) => sample.cacheKind !== "network");
    // A failure before cache classification is conservatively part of the
    // warm gate. Explicit network misses remain outside the warm-cache SLO.
    const warmFailures = failures.filter(
      (failure) => failure.cacheKind !== "network",
    );
    const warmAttempts = warm.length + warmFailures.length;
    const warmP95Ms = percentile95(warm.map((sample) => sample.firstScreenMs));
    const warmSpinnerCount = warm.filter((sample) => sample.spinnerSeen).length;
    const warmPositionFailureCount = warm.filter(
      (sample) => sample.positionOutcome === "unavailable",
    ).length;
    let gate: ReaderPerformanceGate = "collecting";
    if (warmAttempts >= WARM_GATE_MIN_SAMPLES) {
      gate =
        warmP95Ms !== null &&
        warmP95Ms <= WARM_FIRST_SCREEN_TARGET_MS &&
        warmSpinnerCount === 0 &&
        warmPositionFailureCount === 0 &&
        warmFailures.length === 0
          ? "pass"
          : "fail";
    }
    this.snapshot = {
      latest: samples[samples.length - 1] ?? null,
      latestFailure: failures[failures.length - 1] ?? null,
      warmAttempts,
      warmSamples: warm.length,
      warmP95Ms,
      warmSpinnerCount,
      warmPositionFailureCount,
      warmOpenFailureCount: warmFailures.length,
      targetMs: WARM_FIRST_SCREEN_TARGET_MS,
      minimumSamples: WARM_GATE_MIN_SAMPLES,
      gate,
    };
    return this.snapshot;
  };

  begin(event: InstrumentedHotkeyPress): ReaderPerformanceTrace {
    const token = {};
    const timeout = setTimeout(() => {
      this.failToken(token, "首屏在 15 秒内未完成");
    }, TRACE_TIMEOUT_MS);
    const trace: MutableTrace = {
      token,
      sequence: event.sequence,
      detectedAtUnixMs: event.detectedAtUnixMs,
      guideKey: null,
      cacheKind: null,
      spinnerSeen: false,
      routeRequestedAtUnixMs: null,
      routeMountedAtUnixMs: null,
      cacheReadyAtUnixMs: null,
      contentFirstFrameAtUnixMs: null,
      positionSettledAtUnixMs: null,
      positionOutcome: null,
      timeout,
    };
    this.traces.set(token, trace);
    return { token };
  }

  bind(traceHandle: ReaderPerformanceTrace, identity: GuideIdentity): void {
    const trace = this.traces.get(traceHandle.token);
    if (!trace) {
      return;
    }
    const guideKey = makeGuideKey(identity);
    const previous = this.traceByGuide.get(guideKey);
    if (previous && previous !== trace.token) {
      this.failToken(previous, "被后续物理 L4 打开请求取代");
    }
    trace.guideKey = guideKey;
    this.traceByGuide.set(guideKey, trace.token);
  }

  markRouteRequested(traceHandle: ReaderPerformanceTrace): void {
    const trace = this.traces.get(traceHandle.token);
    if (trace && trace.routeRequestedAtUnixMs === null) {
      trace.routeRequestedAtUnixMs = this.clock();
    }
  }

  markRouteMounted(identity: GuideIdentity): void {
    this.updateIdentityTrace(identity, (trace) => {
      trace.routeMountedAtUnixMs ??= this.clock();
    });
  }

  markCacheReady(identity: GuideIdentity, kind: ReaderCacheKind): void {
    this.updateIdentityTrace(identity, (trace) => {
      trace.cacheKind ??= kind;
      trace.cacheReadyAtUnixMs ??= this.clock();
    });
  }

  markSpinner(identity: GuideIdentity): void {
    this.updateIdentityTrace(identity, (trace) => {
      trace.spinnerSeen = true;
    });
  }

  markContentFirstFrame(identity: GuideIdentity): void {
    this.updateIdentityTrace(identity, (trace) => {
      trace.contentFirstFrameAtUnixMs ??= this.clock();
    });
    this.finishIfComplete(identity);
  }

  markPositionSettled(
    identity: GuideIdentity,
    outcome: ReaderPositionOutcome,
  ): void {
    this.updateIdentityTrace(identity, (trace) => {
      trace.positionOutcome ??= outcome;
      trace.positionSettledAtUnixMs ??= this.clock();
    });
    this.finishIfComplete(identity);
  }

  abandon(traceHandle: ReaderPerformanceTrace): void {
    const trace = this.traces.get(traceHandle.token);
    if (!trace) {
      return;
    }
    this.removeTrace(trace);
  }

  fail(traceHandle: ReaderPerformanceTrace, reason: string): void {
    this.failToken(traceHandle.token, reason);
  }

  failIdentity(identity: GuideIdentity, reason: string): void {
    const token = this.traceByGuide.get(makeGuideKey(identity));
    if (token) {
      this.failToken(token, reason);
    }
  }

  clear(): void {
    for (const trace of this.traces.values()) {
      clearTimeout(trace.timeout);
    }
    this.traces.clear();
    this.traceByGuide.clear();
    this.attempts.length = 0;
    this.publish();
  }

  private updateIdentityTrace(
    identity: GuideIdentity,
    update: (trace: MutableTrace) => void,
  ): void {
    const guideKey = makeGuideKey(identity);
    const token = this.traceByGuide.get(guideKey);
    if (!token) {
      return;
    }
    const trace = this.traces.get(token);
    if (trace) {
      update(trace);
    }
  }

  private finishIfComplete(identity: GuideIdentity): void {
    const guideKey = makeGuideKey(identity);
    const token = this.traceByGuide.get(guideKey);
    const trace = token ? this.traces.get(token) : undefined;
    if (
      !trace ||
      trace.cacheKind === null ||
      trace.routeRequestedAtUnixMs === null ||
      trace.routeMountedAtUnixMs === null ||
      trace.cacheReadyAtUnixMs === null ||
      trace.contentFirstFrameAtUnixMs === null ||
      trace.positionSettledAtUnixMs === null ||
      trace.positionOutcome === null
    ) {
      return;
    }
    const firstScreenAtUnixMs = Math.max(
      trace.contentFirstFrameAtUnixMs,
      trace.positionSettledAtUnixMs,
    );
    const sample: ReaderPerformanceSample = {
      sequence: trace.sequence,
      guideKey,
      cacheKind: trace.cacheKind,
      spinnerSeen: trace.spinnerSeen,
      detectedAtUnixMs: trace.detectedAtUnixMs,
      routeRequestedMs: elapsed(
        trace.detectedAtUnixMs,
        trace.routeRequestedAtUnixMs,
      ),
      routeMountedMs: elapsed(
        trace.detectedAtUnixMs,
        trace.routeMountedAtUnixMs,
      ),
      cacheReadyMs: elapsed(trace.detectedAtUnixMs, trace.cacheReadyAtUnixMs),
      contentFirstFrameMs: elapsed(
        trace.detectedAtUnixMs,
        trace.contentFirstFrameAtUnixMs,
      ),
      positionSettledMs: elapsed(
        trace.detectedAtUnixMs,
        trace.positionSettledAtUnixMs,
      ),
      positionOutcome: trace.positionOutcome,
      firstScreenMs: elapsed(trace.detectedAtUnixMs, firstScreenAtUnixMs),
    };
    this.attempts.push({ kind: "success", sample });
    this.trimAttempts();
    this.removeTrace(trace);
    this.publish();
  }

  private failToken(token: object, reason: string): void {
    const trace = this.traces.get(token);
    if (!trace) {
      return;
    }
    const now = this.clock();
    this.attempts.push({
      failure: {
        sequence: trace.sequence,
        guideKey: trace.guideKey,
        cacheKind: trace.cacheKind,
        spinnerSeen: trace.spinnerSeen,
        detectedAtUnixMs: trace.detectedAtUnixMs,
        failedAtMs: elapsed(trace.detectedAtUnixMs, now),
        reason,
      },
      kind: "failure",
    });
    this.trimAttempts();
    this.removeTrace(trace);
    this.publish();
  }

  private removeTrace(trace: MutableTrace): void {
    clearTimeout(trace.timeout);
    this.traces.delete(trace.token);
    if (
      trace.guideKey &&
      this.traceByGuide.get(trace.guideKey) === trace.token
    ) {
      this.traceByGuide.delete(trace.guideKey);
    }
  }

  private trimAttempts(): void {
    while (this.attempts.length > MAX_RETAINED_SAMPLES) {
      this.attempts.shift();
    }
  }

  private publish(): void {
    this.snapshot = null;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
