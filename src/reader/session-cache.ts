import type { CapturedReaderPosition } from "./anchor";
import type { DownloadedGuide, ReaderPosition } from "./types";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

export interface ReaderSessionBackend {
  getGuide(guideId: string, forceRefresh?: boolean): Promise<DownloadedGuide>;
  getReaderPosition(guideKey: string): Promise<ReaderPosition | null>;
  saveReaderPosition(
    guideKey: string,
    scrollTop: number,
    sectionId: string | null,
    anchorText: string | null,
    anchorOffset: number,
  ): Promise<ReaderPosition>;
}

export interface ReaderSessionSnapshot {
  guide: DownloadedGuide;
  position: ReaderPosition | null;
}

export interface ReaderSessionLoadOptions {
  forceRefresh?: boolean;
}

interface ActiveLoad {
  forceRefresh: boolean;
  promise: Promise<ReaderSessionSnapshot>;
}

interface StagedHandoff {
  position: CapturedReaderPosition;
  token: object;
}

const STAGED_POSITION_UPDATED_AT = 0;
const MAX_RETAINED_SESSIONS = 2;

function stagedReaderPosition(
  position: CapturedReaderPosition,
): ReaderPosition {
  return { ...position, updatedAt: STAGED_POSITION_UPDATED_AT };
}

/**
 * Keeps reader data alive for the lifetime of a loaded plugin instance.
 * Consumers should create one cache beside the plugin controller and pass it to
 * every reader route mount.
 */
export class ReaderSessionCache {
  private readonly snapshots = new Map<string, ReaderSessionSnapshot>();
  private readonly activeLoads = new Map<string, ActiveLoad>();
  private readonly stagedHandoffs = new Map<string, StagedHandoff>();
  private readonly stagedSaves = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(
    private readonly backend: ReaderSessionBackend,
    private readonly onStagedSaveError: (error: unknown) => void = () => {},
  ) {}

  peek(identity: GuideIdentity): ReaderSessionSnapshot | null {
    const guideKey = makeGuideKey(identity);
    const snapshot = this.snapshots.get(guideKey) ?? null;
    if (snapshot) {
      this.rememberSnapshot(guideKey, snapshot);
    }
    return snapshot;
  }

  load(
    identity: GuideIdentity,
    options: ReaderSessionLoadOptions = {},
  ): Promise<ReaderSessionSnapshot> {
    const guideKey = makeGuideKey(identity);
    const forceRefresh = options.forceRefresh ?? false;
    const cached = this.snapshots.get(guideKey);
    if (cached && !forceRefresh) {
      this.rememberSnapshot(guideKey, cached);
      const staged = this.stagedHandoffs.get(guideKey);
      if (staged) {
        this.persistStagedHandoff(guideKey, staged, this.generation);
      }
      return Promise.resolve(cached);
    }

    const active = this.activeLoads.get(guideKey);
    if (active) {
      if (!forceRefresh || active.forceRefresh) {
        return active.promise;
      }
      return active.promise.then(
        () => this.load(identity, { forceRefresh: true }),
        () => this.load(identity, { forceRefresh: true }),
      );
    }

    const generation = this.generation;
    const record = {} as ActiveLoad;
    const promise = this.fetch(
      identity,
      guideKey,
      forceRefresh,
      generation,
    ).finally(() => {
      if (this.activeLoads.get(guideKey) === record) {
        this.activeLoads.delete(guideKey);
      }
    });
    record.forceRefresh = forceRefresh;
    record.promise = promise;
    this.activeLoads.set(guideKey, record);
    return promise;
  }

  stageHandoff(
    identity: GuideIdentity,
    position: CapturedReaderPosition,
  ): void {
    const guideKey = makeGuideKey(identity);
    if (this.stagedHandoffs.has(guideKey)) {
      return;
    }

    const cached = this.snapshots.get(guideKey);
    if (cached?.position) {
      return;
    }

    const staged: StagedHandoff = {
      position: { ...position },
      token: {},
    };
    this.stagedHandoffs.set(guideKey, staged);
    if (cached) {
      const next = {
        guide: cached.guide,
        position: stagedReaderPosition(staged.position),
      };
      this.rememberSnapshot(guideKey, next);
      this.persistStagedHandoff(guideKey, staged, this.generation);
    }
  }

  async savePosition(
    identity: GuideIdentity,
    position: CapturedReaderPosition,
  ): Promise<ReaderPosition> {
    const guideKey = makeGuideKey(identity);
    const generation = this.generation;
    this.stagedHandoffs.delete(guideKey);
    const previous = this.snapshots.get(guideKey);
    const optimisticPosition = stagedReaderPosition(position);
    if (previous) {
      this.rememberSnapshot(guideKey, {
        ...previous,
        position: optimisticPosition,
      });
    }
    try {
      const saved = await this.backend.saveReaderPosition(
        guideKey,
        position.scrollTop,
        position.sectionId,
        position.anchorText,
        position.anchorOffset,
      );
      if (generation === this.generation) {
        const cached = this.snapshots.get(guideKey);
        if (cached?.position === optimisticPosition) {
          this.rememberSnapshot(guideKey, { ...cached, position: saved });
        }
      }
      return saved;
    } catch (error: unknown) {
      if (
        generation === this.generation &&
        previous &&
        this.snapshots.get(guideKey)?.position === optimisticPosition
      ) {
        this.rememberSnapshot(guideKey, previous);
      }
      throw error;
    }
  }

  clear(): void {
    this.generation += 1;
    this.snapshots.clear();
    this.activeLoads.clear();
    this.stagedHandoffs.clear();
    this.stagedSaves.clear();
  }

  private async fetch(
    identity: GuideIdentity,
    guideKey: string,
    forceRefresh: boolean,
    generation: number,
  ): Promise<ReaderSessionSnapshot> {
    const [guide, backendPosition] = await Promise.all([
      this.backend.getGuide(identity.guideId, forceRefresh),
      this.backend.getReaderPosition(guideKey),
    ]);
    const staged = this.stagedHandoffs.get(guideKey);
    const adoptedHandoff = backendPosition === null ? staged : undefined;
    const snapshot = {
      guide,
      position: adoptedHandoff
        ? stagedReaderPosition(adoptedHandoff.position)
        : backendPosition,
    };

    if (generation === this.generation) {
      if (backendPosition !== null && staged) {
        this.stagedHandoffs.delete(guideKey);
      }
      this.rememberSnapshot(guideKey, snapshot);
      if (adoptedHandoff) {
        this.persistStagedHandoff(guideKey, adoptedHandoff, generation);
      }
    }
    return snapshot;
  }

  private persistStagedHandoff(
    guideKey: string,
    staged: StagedHandoff,
    generation: number,
  ): void {
    if (this.stagedSaves.has(guideKey)) {
      return;
    }

    const { position } = staged;
    let operation: Promise<void>;
    operation = Promise.resolve()
      .then(() =>
        this.backend.saveReaderPosition(
          guideKey,
          position.scrollTop,
          position.sectionId,
          position.anchorText,
          position.anchorOffset,
        ),
      )
      .then((saved) => {
        if (
          generation !== this.generation ||
          this.stagedHandoffs.get(guideKey)?.token !== staged.token
        ) {
          return;
        }
        this.stagedHandoffs.delete(guideKey);
        const cached = this.snapshots.get(guideKey);
        if (cached) {
          this.rememberSnapshot(guideKey, { ...cached, position: saved });
        }
      })
      .catch((error: unknown) => {
        if (
          generation === this.generation &&
          this.stagedHandoffs.get(guideKey)?.token === staged.token
        ) {
          this.onStagedSaveError(error);
        }
      })
      .finally(() => {
        if (this.stagedSaves.get(guideKey) === operation) {
          this.stagedSaves.delete(guideKey);
        }
      });
    this.stagedSaves.set(guideKey, operation);
  }

  private rememberSnapshot(
    guideKey: string,
    snapshot: ReaderSessionSnapshot,
  ): void {
    this.snapshots.delete(guideKey);
    this.snapshots.set(guideKey, snapshot);
    while (this.snapshots.size > MAX_RETAINED_SESSIONS) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.snapshots.delete(oldestKey);
    }
  }
}
