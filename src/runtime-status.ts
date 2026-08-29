import { RecentGuideIndex, type RecentGuideSeed } from "./reader/recent-guide";
import type { GuideIdentity } from "./steam/guide-key";

export type RuntimePhase = "starting" | "watching" | "error";

export interface GuidePositionStatus extends GuideIdentity {
  scrollTop: number;
}

export interface GripRuntimeStatus {
  phase: RuntimePhase;
  message: string;
  positionWarning: string | null;
  savedCount: number;
  activeGuide: GuideIdentity | null;
  lastGuide: GuideIdentity | null;
  lastCaptured: GuidePositionStatus | null;
  lastRestored: GuidePositionStatus | null;
}

export class RuntimeStatusStore {
  private readonly recentGuides = new RecentGuideIndex();
  private snapshot: GripRuntimeStatus = {
    phase: "starting",
    message: "Connecting to Steam's guide reader…",
    positionWarning: null,
    savedCount: 0,
    activeGuide: null,
    lastGuide: null,
    lastCaptured: null,
    lastRestored: null,
  };

  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): GripRuntimeStatus => this.snapshot;

  readonly getRecentGuide = (appId?: string): GuideIdentity | null =>
    this.recentGuides.find(appId);

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  seedRecentGuides(entries: Iterable<RecentGuideSeed>): void {
    this.recentGuides.seed(entries);
  }

  rememberGuide(identity: GuideIdentity): void {
    this.recentGuides.remember(identity);
  }

  update(update: Partial<GripRuntimeStatus>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
