import type { CapturedReaderPosition } from "./anchor";
import type { DownloadedGuide, ReaderPosition } from "./types";
import { makeGuideKey, type GuideIdentity } from "../steam/guide-key";

export interface ReaderSessionBackend {
  getCachedGuide(guideId: string): Promise<DownloadedGuide | null>;
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
  positionWarning: string | null;
}

export interface ReaderSessionLoadOptions {
  forceRefresh?: boolean;
}

export function retainGuideForStaleRefresh(
  existing: ReaderSessionSnapshot | null,
  refreshed: ReaderSessionSnapshot,
  forceRefresh: boolean,
): ReaderSessionSnapshot {
  if (
    !forceRefresh ||
    !refreshed.guide.stale ||
    !existing ||
    existing.guide.guideId !== refreshed.guide.guideId
  ) {
    return refreshed;
  }
  return { ...refreshed, guide: existing.guide };
}

interface ActiveLoad {
  forceRefresh: boolean;
  promise: Promise<ReaderSessionSnapshot>;
}

interface ActivePreload {
  promise: Promise<ReaderSessionSnapshot | null>;
  token: object;
}

interface StagedHandoff {
  position: CapturedReaderPosition;
  token: object;
}

const STAGED_POSITION_UPDATED_AT = 0;
const MAX_RETAINED_SESSIONS = 2;

interface PositionLoadResult {
  position: ReaderPosition | null;
  warning: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  private readonly activePreloads = new Map<string, ActivePreload>();
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
    // A foreground request permanently revokes the write token of any older
    // preload, even if its newer snapshot is later evicted by the LRU.
    this.activePreloads.delete(guideKey);
    const forceRefresh = options.forceRefresh ?? false;
    const cached = this.snapshots.get(guideKey);
    if (cached && !forceRefresh) {
      this.rememberSnapshot(guideKey, cached);
      const staged = this.stagedHandoffs.get(guideKey);
      if (staged && cached.positionWarning === null) {
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

  preload(identity: GuideIdentity): Promise<ReaderSessionSnapshot | null> {
    const guideKey = makeGuideKey(identity);
    const cached = this.snapshots.get(guideKey);
    if (cached) {
      this.rememberSnapshot(guideKey, cached);
      return Promise.resolve(cached);
    }

    // Foreground loads always win. A preload may join one, but load() never
    // waits for an active preload before starting its foreground request.
    const activeLoad = this.activeLoads.get(guideKey);
    if (activeLoad) {
      return activeLoad.promise;
    }
    const activePreload = this.activePreloads.get(guideKey);
    if (activePreload) {
      return activePreload.promise;
    }

    const generation = this.generation;
    const record = { token: {} } as ActivePreload;
    const promise = this.fetchCached(
      identity,
      guideKey,
      generation,
      record.token,
    ).finally(() => {
      if (this.activePreloads.get(guideKey) === record) {
        this.activePreloads.delete(guideKey);
      }
    });
    record.promise = promise;
    this.activePreloads.set(guideKey, record);
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
        positionWarning: cached.positionWarning,
      };
      this.rememberSnapshot(guideKey, next);
      if (cached.positionWarning === null) {
        this.persistStagedHandoff(guideKey, staged, this.generation);
      }
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
          this.rememberSnapshot(guideKey, {
            ...cached,
            position: saved,
            positionWarning: null,
          });
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

  async retryPosition(identity: GuideIdentity): Promise<ReaderSessionSnapshot> {
    const guideKey = makeGuideKey(identity);
    const existing = this.snapshots.get(guideKey);
    if (!existing) {
      return this.load(identity);
    }
    const generation = this.generation;
    const positionResult = await this.loadPosition(guideKey);
    const staged = this.stagedHandoffs.get(guideKey);
    const adoptedHandoff =
      positionResult.position === null && positionResult.warning === null
        ? staged
        : undefined;
    const current = this.snapshots.get(guideKey) ?? existing;
    const snapshot: ReaderSessionSnapshot = {
      ...current,
      position:
        positionResult.warning !== null
          ? current.position
          : adoptedHandoff
            ? stagedReaderPosition(adoptedHandoff.position)
            : positionResult.position,
      positionWarning: positionResult.warning,
    };
    if (generation === this.generation) {
      this.rememberSnapshot(guideKey, snapshot);
      if (adoptedHandoff) {
        this.persistStagedHandoff(guideKey, adoptedHandoff, generation);
      }
    }
    return snapshot;
  }

  clear(): void {
    this.generation += 1;
    this.snapshots.clear();
    this.activeLoads.clear();
    this.activePreloads.clear();
    this.stagedHandoffs.clear();
    this.stagedSaves.clear();
  }

  private async fetch(
    identity: GuideIdentity,
    guideKey: string,
    forceRefresh: boolean,
    generation: number,
  ): Promise<ReaderSessionSnapshot> {
    const [guide, positionResult] = await Promise.all([
      this.backend.getGuide(identity.guideId, forceRefresh),
      this.loadPosition(guideKey),
    ]);
    const backendPosition = positionResult.position;
    const previousPosition = this.snapshots.get(guideKey)?.position ?? null;
    const staged = this.stagedHandoffs.get(guideKey);
    const adoptedHandoff = backendPosition === null ? staged : undefined;
    const snapshot = {
      guide,
      position:
        positionResult.warning !== null
          ? (previousPosition ??
            (adoptedHandoff
              ? stagedReaderPosition(adoptedHandoff.position)
              : null))
          : adoptedHandoff
            ? stagedReaderPosition(adoptedHandoff.position)
            : backendPosition,
      positionWarning: positionResult.warning,
    };

    if (generation === this.generation) {
      if (backendPosition !== null && staged) {
        this.stagedHandoffs.delete(guideKey);
      }
      this.rememberSnapshot(guideKey, snapshot);
      if (adoptedHandoff && positionResult.warning === null) {
        this.persistStagedHandoff(guideKey, adoptedHandoff, generation);
      }
    }
    return snapshot;
  }

  private async fetchCached(
    identity: GuideIdentity,
    guideKey: string,
    generation: number,
    token: object,
  ): Promise<ReaderSessionSnapshot | null> {
    const guide = await this.backend.getCachedGuide(identity.guideId);
    if (guide === null) {
      return null;
    }
    const positionResult = await this.loadPosition(guideKey);
    const backendPosition = positionResult.position;
    const previousPosition = this.snapshots.get(guideKey)?.position ?? null;
    const staged = this.stagedHandoffs.get(guideKey);
    const adoptedHandoff = backendPosition === null ? staged : undefined;
    const snapshot = {
      guide,
      position:
        positionResult.warning !== null
          ? (previousPosition ??
            (adoptedHandoff
              ? stagedReaderPosition(adoptedHandoff.position)
              : null))
          : adoptedHandoff
            ? stagedReaderPosition(adoptedHandoff.position)
            : backendPosition,
      positionWarning: positionResult.warning,
    };

    if (generation === this.generation) {
      const foregroundSnapshot = this.snapshots.get(guideKey);
      if (foregroundSnapshot) {
        this.rememberSnapshot(guideKey, foregroundSnapshot);
        return foregroundSnapshot;
      }
      if (this.activePreloads.get(guideKey)?.token !== token) {
        return snapshot;
      }
      if (backendPosition !== null && staged) {
        this.stagedHandoffs.delete(guideKey);
      }
      this.rememberSnapshot(guideKey, snapshot);
      // Preloading remains read-only. A later foreground load will persist an
      // adopted handoff through the normal cached-snapshot path.
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
          this.rememberSnapshot(guideKey, {
            ...cached,
            position: saved,
            positionWarning: null,
          });
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

  private async loadPosition(guideKey: string): Promise<PositionLoadResult> {
    try {
      return {
        position: await this.backend.getReaderPosition(guideKey),
        warning: null,
      };
    } catch (error: unknown) {
      return {
        position: null,
        warning: `阅读位置加载失败，正文仍可使用：${errorMessage(error)}`,
      };
    }
  }
}
