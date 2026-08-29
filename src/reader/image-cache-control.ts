export interface ReaderImageCacheControlSnapshot {
  paused: boolean;
}

/**
 * Coordinates the panel's destructive image-cache action with an active
 * reader route. Starting a clear publishes synchronously so queued frontend
 * work drops its Blob results before the backend cache is cleared.
 */
export class ReaderImageCacheControl {
  private snapshot: ReaderImageCacheControlSnapshot = {
    paused: false,
  };
  private activeClear: object | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): ReaderImageCacheControlSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  resume(): void {
    if (this.activeClear) {
      return;
    }
    if (!this.snapshot.paused) {
      return;
    }
    this.snapshot = { paused: false };
    this.publish();
  }

  beginClear(): object {
    if (this.activeClear) {
      throw new Error("image cache cleanup is already running");
    }
    const token = {};
    this.activeClear = token;
    this.snapshot = { paused: true };
    this.publish();
    return token;
  }

  finishClear(token: object, keepPaused: boolean): void {
    if (this.activeClear !== token) {
      return;
    }
    this.activeClear = null;
    this.snapshot = { paused: keepPaused };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
