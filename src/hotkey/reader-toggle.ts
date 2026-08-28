export const READER_ROUTE_PREFIX = "/decky-grip/reader/";

export type HotkeyToggleResult =
  "opened" | "closed" | "ignored" | "busy" | "error";

export interface ReaderHotkeyToggleOptions {
  currentPath: () => string | null;
  gameIsRunning: () => boolean;
  openingIsBlocked?: () => boolean;
  openReader: () => Promise<void>;
  closeReader: () => void | Promise<void>;
  onError: (error: unknown) => void;
}

export function isReaderRoute(path: string | null): boolean {
  return path?.startsWith(READER_ROUTE_PREFIX) ?? false;
}

export function readerRouteAppId(path: string | null): string | null {
  const match = path?.match(/^\/decky-grip\/reader\/([1-9]\d*)\/[1-9]\d*\/?$/);
  return match?.[1] ?? null;
}

export function readerBelongsToStoppedApp(
  path: string | null,
  appId: number,
  running: boolean,
): boolean {
  return !running && readerRouteAppId(path) === String(appId);
}

export class ReaderHotkeyToggle {
  private busy = false;
  private disposed = false;

  constructor(private readonly options: ReaderHotkeyToggleOptions) {}

  dispose(): void {
    this.disposed = true;
  }

  async trigger(): Promise<HotkeyToggleResult> {
    if (this.disposed) {
      return "ignored";
    }
    if (this.busy) {
      return "busy";
    }

    this.busy = true;
    try {
      const shouldClose = isReaderRoute(this.options.currentPath());
      if (
        !shouldClose &&
        (!this.options.gameIsRunning() || this.options.openingIsBlocked?.())
      ) {
        return "ignored";
      }
      if (shouldClose) {
        await this.options.closeReader();
      } else {
        await this.options.openReader();
      }
      return this.disposed ? "ignored" : shouldClose ? "closed" : "opened";
    } catch (error: unknown) {
      if (!this.disposed) {
        this.options.onError(error);
        return "error";
      }
      return "ignored";
    } finally {
      this.busy = false;
    }
  }
}
