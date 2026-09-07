// @vitest-environment happy-dom

import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CacheClearResult, GuideLibraryEntry } from "../../src/backend";
import {
  GuideSwitcher,
  type GuideSwitcherProps,
} from "../../src/components/GuideSwitcher";

vi.mock("@decky/ui", () => {
  type GamepadHandler = (event: {
    detail: { button: number; is_repeat: boolean; source: number };
    preventDefault(): void;
    stopPropagation(): void;
  }) => void;
  interface MockProps {
    children?: ReactNode;
    onCancel?: GamepadHandler;
    onKeyDown?: (event: KeyboardEvent) => void;
    onButtonDown?: GamepadHandler;
    onButtonUp?: GamepadHandler;
    onGamepadFocus?: () => void;
    onGamepadBlur?: () => void;
    onClick?: () => void;
    [key: string]: unknown;
  }
  const element = (tag: "div" | "button") =>
    forwardRef<HTMLElement, MockProps>((props, ref) => {
      const value = props as MockProps;
      const {
        children,
        onCancel,
        onButtonDown,
        onButtonUp,
        onGamepadFocus,
        onGamepadBlur,
        onKeyDown,
        ...dom
      } = value;
      for (const name of [
        "preferredFocus",
        "onCancelActionDescription",
        "onOptionsButton",
      ])
        delete dom[name];
      dom["data-ok-action"] = dom.onOKActionDescription;
      delete dom.onOKActionDescription;
      const gamepad = (event: KeyboardEvent) => ({
        detail: { button: 1, is_repeat: event.repeat, source: 0 },
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
      return createElement(
        tag,
        {
          ...dom,
          ref,
          onFocus: onGamepadFocus,
          onBlur: onGamepadBlur,
          onKeyDown: (event: KeyboardEvent) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === "GamepadCancel") {
              const cancel = gamepad(event);
              cancel.detail.button = 2;
              onCancel?.(cancel);
            }
            if (event.key === "Enter") {
              onButtonDown?.(gamepad(event));
              if (tag === "button" && !event.repeat) value.onClick?.();
            }
          },
          onKeyUp: (event: KeyboardEvent) => {
            if (event.key === "Enter") onButtonUp?.(gamepad(event));
          },
        },
        children,
      );
    });
  return {
    Button: element("button"),
    Focusable: element("div"),
    GamepadButton: { OK: 1 },
    Spinner: () => createElement("span"),
  };
});

function entry(guideId: string): GuideLibraryEntry {
  return {
    appId: "10",
    guideId,
    updatedAt: 1,
    cache: {
      title: `指南 ${guideId}`,
      author: `作者 ${guideId}`,
      fetchedAt: 1,
      sectionTitle: `章节 ${guideId}`,
      stale: false,
    },
  };
}

describe("GuideSwitcher", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: GuideSwitcherProps;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      entries: [entry("1"), entry("2"), entry("3")],
      currentGuideId: "1",
      pendingKey: null,
      error: null,
      removed: false,
      removeDisabled: false,
      onChoose: vi.fn(),
      onReload: vi.fn(),
      onClose: vi.fn(),
      onRemove: vi.fn(async () => ({
        filesRemoved: 2,
        bytesRemoved: 1_048_576,
      })),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const render = async (patch: Partial<GuideSwitcherProps> = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(<GuideSwitcher {...props} />));
    await act(async () => vi.advanceTimersByTimeAsync(0));
  };
  const choice = (id: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-grip-guide-choice="10:${id}"]`,
    )!;
  const dialog = () =>
    container.querySelector<HTMLElement>('[aria-label="切换指南"]')!;
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === label,
    )!;
  const click = async (node: HTMLElement) => {
    await act(async () => {
      node.focus();
      node.click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
  };
  const key = async (
    node: HTMLElement,
    value: string,
    type = "keydown",
    options: KeyboardEventInit = {},
  ) => {
    await act(async () =>
      node.dispatchEvent(
        new KeyboardEvent(type, {
          key: value,
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
  };

  it("shows all cards, prefers an alternative, and lets A return to the current guide", async () => {
    await render();
    expect(container.querySelectorAll("[data-grip-guide-choice]")).toHaveLength(
      3,
    );
    expect(container.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(choice("2"));
    expect(choice("2").textContent).toContain("作者：作者 2");
    expect(choice("2").textContent).toContain("上次：章节 2");
    expect(choice("1").getAttribute("data-current")).toBe("true");
    expect(choice("1").getAttribute("aria-current")).toBe("page");
    expect(dialog().style.top).toBe("40px");
    expect(dialog().style.paddingBottom).toBe("56px");
    await key(choice("1"), "Enter");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("moves from loading to a card, including when only the current guide exists", async () => {
    await render({ entries: null });
    expect(document.activeElement).toBe(dialog());
    expect(dialog().textContent).toContain("正在读取本游戏指南");
    await render({ entries: [entry("1")] });
    expect(document.activeElement).toBe(choice("1"));
    await render({ entries: [entry("1"), entry("2")] });
    expect(document.activeElement).toBe(choice("1"));
  });

  it("keeps the chosen card and title through progress and errors, and retries opening it", async () => {
    await render();
    const target = choice("3");
    await click(target);
    expect(props.onChoose).toHaveBeenLastCalledWith(props.entries![2]);
    await render({ pendingKey: "10:3" });
    expect(choice("3")).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(target.disabled).toBe(false);
    expect(target.getAttribute("aria-busy")).toBe("true");
    expect(target.textContent).toContain("指南 3");
    expect(target.textContent).toContain("正在准备并打开");
    await click(target);
    expect(props.onChoose).toHaveBeenCalledOnce();
    await render({ pendingKey: null, error: "指南打开失败：读取失败" });
    expect(document.activeElement).toBe(target);
    expect(choice("3")).toBe(target);
    expect(target.getAttribute("aria-busy")).toBe("false");
    expect(target.getAttribute("data-ok-action")).toBe("重试打开");
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "按 A 重试打开",
    );
    expect(container.querySelector("[data-grip-guide-list-retry]")).toBeNull();
    await key(target, "Enter");
    expect(props.onChoose).toHaveBeenCalledTimes(2);
    expect(props.onReload).not.toHaveBeenCalled();
  });

  it("does not steal a valid card focus when entries or a list error change", async () => {
    await render();
    const target = choice("3");
    await act(async () => target.focus());
    await render({
      entries: [entry("1"), entry("2"), { ...entry("3"), updatedAt: 2 }],
      error: "列表读取失败",
    });
    expect(choice("3")).toBe(target);
    expect(document.activeElement).toBe(target);
    await click(button("重新读取指南列表"));
    expect(props.onReload).toHaveBeenCalledOnce();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("focuses list retry when loading failed and has a readable empty state", async () => {
    await render({ entries: null, error: "列表读取失败" });
    expect(document.activeElement).toBe(button("重新读取指南列表"));
    await render({ entries: [], error: null });
    expect(document.activeElement).toBe(dialog());
    expect(dialog().textContent).toContain("还没有已记录的指南");
  });

  it("exposes focus and pressed feedback while respecting reduced motion", async () => {
    await render();
    const target = choice("2");
    expect(target.getAttribute("data-focused")).toBe("true");
    await key(target, "Enter");
    expect(target.getAttribute("data-pressed")).toBe("true");
    await key(target, "Enter", "keyup");
    expect(target.hasAttribute("data-pressed")).toBe(false);
    await act(async () => choice("3").focus());
    expect(target.hasAttribute("data-focused")).toBe(false);
    const css = container.querySelector("style")!.textContent!;
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(
      "animation: none; transition: none; transform: none;",
    );
  });

  it("requires confirmation, defaults to cancel, and handles B at each level", async () => {
    await render();
    const trigger = button("删除当前指南离线副本");
    await click(trigger);
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("取消"));
    expect(
      container.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain("指南 1");
    const escaped = vi.fn();
    document.body.addEventListener("keydown", escaped);
    await key(button("取消"), "Escape");
    document.body.removeEventListener("keydown", escaped);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(escaped).not.toHaveBeenCalled();
    await key(trigger, "Escape");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it.each(["Escape", "GamepadCancel"])(
    "consumes %s repeats so a held key only returns one level",
    async (value) => {
      await render();
      const trigger = button("删除当前指南离线副本");
      await click(trigger);
      await key(button("取消"), value, "keydown", { repeat: true });
      expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
      await key(button("取消"), value);
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(props.onClose).not.toHaveBeenCalled();
      await key(trigger, value, "keydown", { repeat: true });
      expect(props.onClose).not.toHaveBeenCalled();
      await key(trigger, value);
      expect(props.onClose).toHaveBeenCalledOnce();
      await key(trigger, value, "keydown", { repeat: true });
      expect(props.onClose).toHaveBeenCalledOnce();
    },
  );

  it("keeps real Tab focus inside the visible switcher or its deletion confirmation", async () => {
    await render();
    const trigger = button("删除当前指南离线副本");
    await act(async () => trigger.focus());
    await key(trigger, "Tab");
    expect(document.activeElement).toBe(choice("1"));
    await key(choice("1"), "Tab", "keydown", { shiftKey: true });
    expect(document.activeElement).toBe(trigger);
    await act(async () => dialog().focus());
    await key(dialog(), "Tab", "keydown", { shiftKey: true });
    expect(document.activeElement).toBe(trigger);
    await click(trigger);
    const cancel = button("取消");
    const confirm = button("确认删除");
    await key(cancel, "Tab", "keydown", { shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    await key(confirm, "Tab");
    expect(document.activeElement).toBe(cancel);
    await key(cancel, "Escape");
    expect(document.activeElement).toBe(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("blocks dismissal and repeat deletion while busy without disabling the focused button", async () => {
    let resolve!: (result: CacheClearResult) => void;
    await render({
      onRemove: vi.fn(
        () =>
          new Promise<CacheClearResult>((done) => {
            resolve = done;
          }),
      ),
    });
    await click(button("删除当前指南离线副本"));
    const confirm = button("确认删除");
    await click(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toContain("正在删除");
    await key(confirm, "Escape");
    await click(button("取消"));
    await click(confirm);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onRemove).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () =>
      resolve({ bytesRemoved: 1_048_576, filesRemoved: 3 }),
    );
    await render({ removed: true });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(dialog().textContent).toContain("释放 1.0 MiB");
    expect(choice("1").textContent).toContain("当前会话仍可阅读");
    await click(button("删除当前指南离线副本"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(props.onRemove).toHaveBeenCalledOnce();
  });

  it("keeps failed removal in confirmation and allows an explicit retry", async () => {
    const onRemove = vi
      .fn()
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValueOnce({ bytesRemoved: 0, filesRemoved: 1 });
    await render({ onRemove });
    await click(button("删除当前指南离线副本"));
    const confirm = button("确认删除");
    await click(confirm);
    expect(button("确认删除")).toBe(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(
      container.querySelector('[role="alertdialog"] [role="alert"]')
        ?.textContent,
    ).toContain("磁盘忙");
    await click(confirm);
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("does not offer deletion while disabled or already removed", async () => {
    await render({ removeDisabled: true });
    await click(button("删除当前指南离线副本"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await render({ removeDisabled: false, removed: true });
    await click(button("删除当前指南离线副本"));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(props.onRemove).not.toHaveBeenCalled();
  });
});
