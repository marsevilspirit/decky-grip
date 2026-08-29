import { describe, expect, it, vi } from "vitest";

import {
  isReaderRoute,
  readerBelongsToStoppedApp,
  readerRouteAppId,
  ReaderHotkeyToggle,
} from "../../src/hotkey/reader-toggle";

describe("L4 reader hotkey", () => {
  it("recognizes only GRIP reader routes", () => {
    expect(isReaderRoute("/decky-grip/reader/1113000/3414883877")).toBe(true);
    expect(isReaderRoute("/apprunning")).toBe(false);
    expect(isReaderRoute(null)).toBe(false);
  });

  it("matches game-exit notifications only to their reader owner", () => {
    const path = "/decky-grip/reader/1113000/3414883877";
    expect(readerRouteAppId(path)).toBe("1113000");
    expect(readerRouteAppId("/decky-grip/reader/invalid/10")).toBeNull();
    expect(readerBelongsToStoppedApp(path, 1113000, false)).toBe(true);
    expect(readerBelongsToStoppedApp(path, 1113000, true)).toBe(false);
    expect(readerBelongsToStoppedApp(path, 222, false)).toBe(false);
    expect(readerBelongsToStoppedApp("/apprunning", 1113000, false)).toBe(
      false,
    );
  });

  it("opens from a running game and closes from the reader", async () => {
    let path = "/apprunning";
    const openReader = vi.fn(async () => {
      path = "/decky-grip/reader/1113000/3414883877";
    });
    const closeReader = vi.fn(() => {
      path = "/apprunning";
    });
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => path,
      gameIsRunning: () => true,
      openReader,
      closeReader,
      onError: vi.fn(),
    });

    await expect(toggle.trigger()).resolves.toBe("opened");
    await expect(toggle.trigger()).resolves.toBe("closed");
    expect(openReader).toHaveBeenCalledOnce();
    expect(closeReader).toHaveBeenCalledOnce();
  });

  it("passes the instrumented physical detection event only to an open", async () => {
    let path = "/apprunning";
    const openReader = vi.fn(async () => {
      path = "/decky-grip/reader/1113000/3414883877";
    });
    const event = {
      version: 1 as const,
      button: "L4" as const,
      sequence: 12,
      detectedAtUnixMs: 123_456,
    };
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => path,
      gameIsRunning: () => true,
      openReader,
      closeReader: vi.fn(),
      onError: vi.fn(),
    });

    await expect(toggle.trigger(event)).resolves.toBe("opened");
    await expect(toggle.trigger(event)).resolves.toBe("closed");
    expect(openReader).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("ignores presses outside a game and suppresses overlapping opens", async () => {
    let resolveOpen: (() => void) | undefined;
    const openReader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    let gameRunning = false;
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => "/apprunning",
      gameIsRunning: () => gameRunning,
      openReader,
      closeReader: vi.fn(),
      onError: vi.fn(),
    });

    await expect(toggle.trigger()).resolves.toBe("ignored");
    gameRunning = true;
    const opening = toggle.trigger();
    await expect(toggle.trigger()).resolves.toBe("busy");
    resolveOpen?.();
    await expect(opening).resolves.toBe("opened");
  });

  it("suppresses overlapping closes", async () => {
    let resolveClose: (() => void) | undefined;
    const closeReader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => "/decky-grip/reader/1113000/3414883877",
      gameIsRunning: () => true,
      openReader: vi.fn(),
      closeReader,
      onError: vi.fn(),
    });

    const closing = toggle.trigger();
    await expect(toggle.trigger()).resolves.toBe("busy");
    resolveClose?.();
    await expect(closing).resolves.toBe("closed");
    expect(closeReader).toHaveBeenCalledOnce();
  });

  it("blocks opening over an editor but always allows the reader to close", async () => {
    let path = "/apprunning";
    const openReader = vi.fn();
    const closeReader = vi.fn();
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => path,
      gameIsRunning: () => true,
      openingIsBlocked: () => true,
      openReader,
      closeReader,
      onError: vi.fn(),
    });

    await expect(toggle.trigger()).resolves.toBe("ignored");
    path = "/decky-grip/reader/1113000/3414883877";
    await expect(toggle.trigger()).resolves.toBe("closed");
    expect(openReader).not.toHaveBeenCalled();
    expect(closeReader).toHaveBeenCalledOnce();
  });

  it("reports an open failure and unlocks the next attempt", async () => {
    const failure = new Error("no guide");
    const onError = vi.fn();
    const openReader = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => "/apprunning",
      gameIsRunning: () => true,
      openReader,
      closeReader: vi.fn(),
      onError,
    });

    await expect(toggle.trigger()).resolves.toBe("error");
    await expect(toggle.trigger()).resolves.toBe("opened");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reports a dead Steam window probe and unlocks the next attempt", async () => {
    const failure = new Error("dead object");
    const onError = vi.fn();
    const currentPath = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue("/apprunning");
    const toggle = new ReaderHotkeyToggle({
      currentPath,
      gameIsRunning: () => true,
      openReader: vi.fn(),
      closeReader: vi.fn(),
      onError,
    });

    await expect(toggle.trigger()).resolves.toBe("error");
    await expect(toggle.trigger()).resolves.toBe("opened");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reports a close failure and unlocks the next attempt", async () => {
    const failure = new Error("could not close");
    const onError = vi.fn();
    const closeReader = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => "/decky-grip/reader/1113000/3414883877",
      gameIsRunning: () => true,
      openReader: vi.fn(),
      closeReader,
      onError,
    });

    await expect(toggle.trigger()).resolves.toBe("error");
    await expect(toggle.trigger()).resolves.toBe("closed");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("ignores future work and suppresses late errors after disposal", async () => {
    let rejectOpen: ((error: Error) => void) | undefined;
    const onError = vi.fn();
    const toggle = new ReaderHotkeyToggle({
      currentPath: () => "/apprunning",
      gameIsRunning: () => true,
      openReader: () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        }),
      closeReader: vi.fn(),
      onError,
    });

    const opening = toggle.trigger();
    toggle.dispose();
    rejectOpen?.(new Error("unloaded"));

    await expect(opening).resolves.toBe("ignored");
    await expect(toggle.trigger()).resolves.toBe("ignored");
    expect(onError).not.toHaveBeenCalled();
  });
});
