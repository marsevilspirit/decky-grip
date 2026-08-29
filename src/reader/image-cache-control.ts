export interface ReaderImageCacheControlSnapshot {
  clearing: boolean;
  generation: number;
  paused: boolean;
}

/**
 * Coordinates the panel's destructive image-cache action with an active
 * reader route. Pausing publishes synchronously so queued frontend work drops
 * its Blob results before the backend cache is cleared.
 */
export class ReaderImageCacheControl {
  private snapshot: ReaderImageCacheControlSnapshot = {
    clearing: false,
    generation: 0,
    paused: false,
  };
  private activeClear: object | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): ReaderImageCacheControlSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  pause(): void {
    this.snapshot = {
      ...this.snapshot,
      generation: this.snapshot.generation + 1,
      paused: true,
    };
    this.publish();
  }

  resume(): boolean {
    if (this.activeClear) {
      return false;
    }
    if (!this.snapshot.paused) {
      return true;
    }
    this.snapshot = { ...this.snapshot, paused: false };
    this.publish();
    return true;
  }

  beginClear(): object {
    if (this.activeClear) {
      throw new Error("image cache cleanup is already running");
    }
    const token = {};
    this.activeClear = token;
    this.snapshot = {
      clearing: true,
      generation: this.snapshot.generation + 1,
      paused: true,
    };
    this.publish();
    return token;
  }

  finishClear(token: object, keepPaused: boolean): void {
    if (this.activeClear !== token) {
      return;
    }
    this.activeClear = null;
    this.snapshot = {
      ...this.snapshot,
      clearing: false,
      paused: keepPaused,
    };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
