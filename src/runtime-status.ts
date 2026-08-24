import type { GuideIdentity } from "./steam/guide-key";

export type RuntimePhase = "starting" | "watching" | "error";

export interface GuidePositionStatus extends GuideIdentity {
  scrollTop: number;
}

export interface GripRuntimeStatus {
  phase: RuntimePhase;
  message: string;
  savedCount: number;
  activeGuide: GuideIdentity | null;
  lastCaptured: GuidePositionStatus | null;
  lastRestored: GuidePositionStatus | null;
}

export class RuntimeStatusStore {
  private snapshot: GripRuntimeStatus = {
    phase: "starting",
    message: "Connecting to Steam's guide reader…",
    savedCount: 0,
    activeGuide: null,
    lastCaptured: null,
    lastRestored: null,
  };

  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): GripRuntimeStatus => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(update: Partial<GripRuntimeStatus>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
