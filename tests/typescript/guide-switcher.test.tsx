// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as DeckyUI from "@decky/ui";

import type { CacheClearResult, GuideLibraryEntry } from "../../src/backend";
import {
  GuideSwitcher,
  type GuideSwitcherProps,
} from "../../src/components/GuideSwitcher";
import { GamepadButton, gamepadEvent } from "./helpers/decky-gamepad";
import type { MockDeckyProps } from "./helpers/decky-ui";

vi.mock("@decky/ui", async () => {
  const { GamepadButton } = await import("./helpers/decky-gamepad");
  const {
    mockDeckyElement,
    mockDialogButton,
    mockField,
    mockScrollPanel,
    mockSimpleModal,
    mockModalRoot,
    mockConfirmModal,
  } = await import("./helpers/decky-ui");
  type GamepadHandler = (event: {
    detail: { button: number; is_repeat: boolean; source: number };
    preventDefault(): void;
    stopPropagation(): void;
  }) => void;
  interface MockProps extends MockDeckyProps {
    onCancel?: GamepadHandler;
    onKeyDown?: (event: KeyboardEvent) => void;
    onButtonDown?: GamepadHandler;
    onButtonUp?: GamepadHandler;
    onClick?: (event: KeyboardEvent) => void;
  }
  const keyboard = (props: MockDeckyProps, tag: "div" | "button") => {
    const value = props as MockProps;
    const { onCancel, onButtonDown, onButtonUp, onKeyDown } = value;
    const gamepad = (event: KeyboardEvent) => ({
      detail: {
        button: GamepadButton.OK,
        is_repeat: event.repeat,
        source: 0,
      },
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    });
    return {
      onKeyDown: (event: KeyboardEvent) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "GamepadCancel") {
          const cancel = gamepad(event);
          cancel.detail.button = GamepadButton.CANCEL;
          onCancel?.(cancel);
        }
        if (event.key === "Enter") {
          onButtonDown?.(gamepad(event));
          if (tag === "button" && !event.repeat) value.onClick?.(event);
        }
      },
      onKeyUp: (event: KeyboardEvent) => {
        if (event.key === "Enter") onButtonUp?.(gamepad(event));
      },
    };
  };
  const Button = mockDeckyElement("button", keyboard);
  return {
    Button,
    DialogButton: mockDialogButton(keyboard),
    Field: mockField(keyboard),
    ScrollPanel: mockScrollPanel(keyboard),
    Marquee: ({ children }: MockDeckyProps) =>
      createElement("div", { "data-native-marquee": true }, children),
    SimpleModal: mockSimpleModal,
    ModalRoot: mockModalRoot,
    ConfirmModal: vi.fn(mockConfirmModal),
    DialogBody: mockDeckyElement("div"),
    DialogHeader: (props: MockDeckyProps) =>
      createElement("div", {
        ...props,
        className: "DialogHeader",
        role: "heading",
      }),
    DialogBodyText: (props: MockDeckyProps) =>
      createElement("div", { ...props, className: "DialogBodyText" }),
    Focusable: mockDeckyElement("div", keyboard),
    GamepadButton,
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
      listError: null,
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
    container.querySelector<HTMLElement>(
      `[data-grip-guide-choice="10:${id}"]`,
    )!;
  const dialog = () =>
    container.querySelector<HTMLElement>('[aria-label="切换指南"]')!;
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === label,
    )!;
  const confirmationProps = () => {
    const calls = vi.mocked(DeckyUI.ConfirmModal).mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  };
  const manage = async (id: string) => {
    await act(async () => {
      const target = choice(id);
      target.focus();
      target.dispatchEvent(
        gamepadEvent("onSecondaryButton", GamepadButton.SECONDARY),
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
  };
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
        value === "GamepadCancel"
          ? gamepadEvent("onCancel", GamepadButton.CANCEL, options.repeat)
          : value === "Enter" &&
              type === "keydown" &&
              node.hasAttribute("data-native-field")
            ? gamepadEvent("onOKButton", GamepadButton.OK, options.repeat)
            : new KeyboardEvent(type, {
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
    expect(container.querySelector("[data-grip-guide-manage]")).toBeNull();
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(3);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    for (const id of ["1", "2", "3"])
      expect(choice(id).getAttribute("data-secondary-action")).toBe("管理指南");
    expect(document.activeElement).toBe(choice("2"));
    expect(choice("2").textContent).toContain("作者：作者 2");
    expect(choice("2").textContent).toContain("上次：章节 2");
    expect(choice("1").getAttribute("data-current")).toBe("true");
    expect(choice("1").getAttribute("aria-current")).toBe("page");
    expect(choice("2").getAttribute("data-native-preferred-focus")).toBe(
      "true",
    );
    expect(container.querySelector("[data-native-modal]")).not.toBeNull();
    await key(choice("1"), "Enter");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("manages the explicit card rather than the current or last opened guide, even after list reorder", async () => {
    await render();
    await click(choice("3"));
    await manage("2");
    const target = props.entries![1];
    expect(document.activeElement).toBe(button("取消"));
    const confirmation = container.querySelector(
      '[role="dialog"][aria-label^="管理指南："]',
    )!;
    expect(confirmation.getAttribute("aria-label")).toBe("管理指南：指南 2");
    expect(confirmation.textContent).toContain("来源：Steam");
    expect(confirmation.textContent).toContain("作者：作者 2");
    expect(confirmation.textContent).toContain("阅读位置");
    await render({ entries: [entry("3"), entry("1"), entry("2")] });
    await click(button("确认卸载"));
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(target);
    expect(choice("2").textContent).toContain("释放 1.0 MiB");
    expect(choice("1").textContent).not.toContain("已卸载");
    expect(document.activeElement).toBe(choice("2"));
    await manage("3");
    await click(button("确认卸载"));
    expect(props.onRemove).toHaveBeenLastCalledWith(props.entries![0]);
    expect(props.onRemove).toHaveBeenCalledTimes(2);
  });

  it.each(["gamepad"])(
    "opens the focused card's management with %s, consumes repeats, and returns to that card",
    async (input) => {
      await render();
      const target = choice("2");
      const escaped = vi.fn();
      document.body.addEventListener("onSecondaryButton", escaped);
      if (input === "gamepad") {
        const repeat = gamepadEvent(
          "onSecondaryButton",
          GamepadButton.SECONDARY,
          true,
        );
        await act(async () => target.dispatchEvent(repeat));
        expect(repeat.defaultPrevented).toBe(true);
        expect(
          container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
        ).toBeNull();
        const event = gamepadEvent(
          "onSecondaryButton",
          GamepadButton.SECONDARY,
        );
        await act(async () => target.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        await act(async () => vi.advanceTimersByTimeAsync(0));
      } else {
        await key(target, input, "keydown", { repeat: true });
        expect(
          container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
        ).toBeNull();
        await key(target, input);
      }
      document.body.removeEventListener("onSecondaryButton", escaped);
      expect(escaped).not.toHaveBeenCalled();
      expect(
        container
          .querySelector('[role="dialog"][aria-label^="管理指南："]')
          ?.getAttribute("aria-label"),
      ).toBe("管理指南：指南 2");
      expect(props.onChoose).not.toHaveBeenCalled();
      expect(props.onRemove).not.toHaveBeenCalled();
      await key(button("取消"), "Escape");
      expect(document.activeElement).toBe(target);
      expect(props.onClose).not.toHaveBeenCalled();
    },
  );

  it("allows explicit leftover cleanup when the body disappeared while management was open", async () => {
    await render();
    await manage("2");
    await render({
      entries: [entry("1"), { ...entry("2"), cache: null }, entry("3")],
    });
    expect(button("确认清理残留").classList.contains("Disabled")).toBe(false);
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[role="dialog"][aria-label^="管理指南："]')
        ?.getAttribute("aria-label"),
    ).toBe("管理指南：指南 2");
    await click(button("确认清理残留"));
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(entry("2"));
  });

  it("moves from loading to a card, including when only the current guide exists", async () => {
    await render({ entries: null });
    expect(dialog().textContent).toContain("正在读取本游戏指南");
    await render({ entries: [entry("1")] });
    expect(choice("1").getAttribute("data-native-preferred-focus")).toBe(
      "true",
    );
    await render({ entries: [entry("1"), entry("2")] });
    expect(choice("2").getAttribute("data-native-preferred-focus")).toBe(
      "true",
    );
  });

  it("keeps the chosen card and title through progress and errors, and retries opening it", async () => {
    await render();
    const target = choice("3");
    await click(target);
    expect(props.onChoose).toHaveBeenLastCalledWith(props.entries![2]);
    await render({ pendingKey: "10:3" });
    expect(choice("3")).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(target.hasAttribute("disabled")).toBe(false);
    expect(target.classList.contains("Disabled")).toBe(true);
    expect(target.getAttribute("data-native-focusable")).toBe("true");
    expect(choice("2").classList.contains("Disabled")).toBe(true);
    expect(choice("1").classList.contains("Disabled")).toBe(false);
    expect(target.hasAttribute("data-ok-action")).toBe(false);
    expect(target.hasAttribute("data-secondary-action")).toBe(false);
    expect(choice("1").getAttribute("data-ok-action")).toBe("返回阅读");
    expect(choice("1").hasAttribute("data-secondary-action")).toBe(false);
    expect(target.getAttribute("aria-busy")).toBe("true");
    expect(target.textContent).toContain("指南 3");
    expect(target.textContent).toContain("正在准备并打开");
    await manage("2");
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).toBeNull();
    await key(choice("2"), "x");
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).toBeNull();
    await click(target);
    await key(target, "Enter");
    expect(props.onChoose).toHaveBeenCalledOnce();
    await render({ pendingKey: null, error: "指南打开失败：读取失败" });
    expect(document.activeElement).toBe(target);
    expect(choice("3")).toBe(target);
    expect(target.getAttribute("aria-busy")).toBe("false");
    expect(target.classList.contains("Disabled")).toBe(false);
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
      listError: "列表读取失败",
    });
    expect(choice("3")).toBe(target);
    expect(document.activeElement).toBe(target);
    await render({ pendingKey: "10:2" });
    const retry = button("重新读取指南列表");
    expect(retry.classList.contains("Disabled")).toBe(true);
    expect(retry.getAttribute("data-native-focusable")).toBe("true");
    await click(retry);
    expect(props.onReload).not.toHaveBeenCalled();
    await render({ pendingKey: null });
    expect(retry.classList.contains("Disabled")).toBe(false);
    await click(button("重新读取指南列表"));
    expect(props.onReload).toHaveBeenCalledOnce();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("focuses list retry when loading failed and has a readable empty state", async () => {
    await render({ entries: null, listError: "列表读取失败" });
    expect(document.activeElement).toBe(button("重新读取指南列表"));
    await render({ entries: [], listError: null });
    expect(dialog().textContent).toContain("还没有已记录的指南");
  });

  it("uses native Steam controls without repainting their focus or pressed states", async () => {
    const longEntry = entry("2");
    longEntry.cache!.title = "很长的指南标题".repeat(30);
    await render({ entries: [entry("1"), longEntry, entry("3")] });
    const target = choice("2");
    expect(
      container.querySelector("[data-native-modal]")?.contains(dialog()),
    ).toBe(true);
    expect(container.querySelector(".DialogHeader")?.textContent).toBe(
      "本游戏指南",
    );
    expect(target.classList.contains("Field")).toBe(true);
    expect(target.tagName).toBe("DIV");
    expect(target.getAttribute("role")).toBe("button");
    expect(target.tabIndex).toBe(0);
    expect(target.getAttribute("data-native-highlight-on-focus")).toBe("true");
    expect(
      target.querySelector(".FieldLabel [data-native-marquee]")?.textContent,
    ).toBe(longEntry.cache!.title);
    expect(target.textContent).toContain(longEntry.cache!.title);
    expect(target.textContent).toContain("作者 2");
    expect(target.querySelector(".FieldDescription")?.textContent).toContain(
      "作者 2",
    );
    expect(
      [...target.querySelectorAll("div")].every((node) => !node.style.color),
    ).toBe(true);
    expect(document.activeElement).toBe(target);
    await key(target, "Enter");
    expect(props.onChoose).toHaveBeenCalledExactlyOnceWith(longEntry);
    await key(target, "Enter", "keyup");
    expect(target.hasAttribute("data-pressed")).toBe(false);
    await act(async () => choice("3").focus());
    expect(target.hasAttribute("data-focused")).toBe(false);
    expect(container.querySelector("style")).toBeNull();
    expect(dialog().style.background).toBe("");
    await manage("2");
    const confirmation = container.querySelector(
      '[role="dialog"][aria-label^="管理指南："]',
    )!;
    expect(confirmation.getAttribute("aria-label")).toBe(
      `管理指南：${longEntry.cache!.title}`,
    );
    expect(
      confirmation.querySelector(".DialogBodyText")?.textContent,
    ).toContain("来源：Steam");
    expect(button("取消").classList.contains("DialogButton")).toBe(true);
    expect(button("确认卸载").classList.contains("DialogButton")).toBe(true);
  });

  it("hands directional, Tab and scroll behavior to Steam's column navigation", async () => {
    await render({
      entries: Array.from({ length: 20 }, (_, index) =>
        entry(String(index + 1)),
      ),
    });
    const reveal = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const list = container.querySelector<HTMLElement>(
      "[data-grip-guide-list]",
    )!;
    expect(list.dataset.nativeFlow).toBe("column");
    expect(list.dataset.nativeScrollPanel).toBe("y");
    expect(list.style.overflowY).toBe("");
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Tab", "x"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => choice("2").dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    await act(async () => choice("20").focus());
    expect(reveal).not.toHaveBeenCalled();
    expect(props.onChoose).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("requires confirmation, defaults to cancel, and handles B at each level", async () => {
    await render();
    const trigger = choice("1");
    await manage("1");
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("取消"));
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]')
        ?.textContent,
    ).toContain("指南 1");
    const escaped = vi.fn();
    document.body.addEventListener("keydown", escaped);
    await key(button("取消"), "Escape");
    document.body.removeEventListener("keydown", escaped);
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(escaped).not.toHaveBeenCalled();
    await key(trigger, "Escape");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it.each(["Escape", "GamepadCancel"])(
    "consumes %s repeats after native confirmation closes so a held key only returns one level",
    async (value) => {
      await render();
      const trigger = choice("1");
      await manage("1");
      await key(button("取消"), value);
      expect(
        container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
      ).toBeNull();
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

  it("uses native safe confirmation defaults and its modal return stack", async () => {
    await render();
    const trigger = choice("3");
    await act(async () => trigger.focus());
    await manage("3");
    expect(container.querySelectorAll("[data-native-modal]")).toHaveLength(2);
    expect(confirmationProps()).toMatchObject({
      bCloseAfterOK: false,
      focusButton: "secondary",
      bDisableBackgroundDismiss: true,
      bDestructiveWarning: true,
    });
    const cancel = button("取消");
    expect(document.activeElement).toBe(cancel);
    await key(cancel, "Escape");
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelectorAll("[data-native-modal]")).toHaveLength(1);
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
    await manage("1");
    const confirm = button("确认卸载");
    await act(async () => {
      confirm.focus();
      confirm.click();
      confirm.click();
    });
    expect(document.activeElement).toBe(confirm);
    expect(confirm.disabled).toBe(false);
    expect(confirm.classList.contains("Disabled")).toBe(true);
    expect(button("取消").classList.contains("Disabled")).toBe(true);
    expect(confirm.textContent).toContain("正在卸载");
    // Steam calls closeModal after its cancel callback even when cancel is disabled.
    await act(async () => {
      (confirmationProps().onCancel as () => void)();
      (confirmationProps().closeModal as () => void)();
    });
    await key(confirm, "Escape");
    await click(button("取消"));
    await click(confirm);
    await key(choice("2"), "x");
    await manage("2");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(props.entries![0]);
    expect(
      container
        .querySelector('[role="dialog"][aria-label^="管理指南："]')
        ?.getAttribute("aria-label"),
    ).toBe("管理指南：指南 1");
    await act(async () =>
      resolve({ bytesRemoved: 1_048_576, filesRemoved: 3 }),
    );
    await render({ removed: true });
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).toBeNull();
    expect(dialog().textContent).toContain("释放 1.0 MiB");
    expect(choice("1").textContent).toContain("当前会话仍可阅读");
    await manage("1");
    expect(button("确认卸载").classList.contains("Disabled")).toBe(true);
    await click(button("确认卸载"));
    expect(props.onRemove).toHaveBeenCalledOnce();
  });

  it("keeps partial cleanup retryable after canceling and reopening management", async () => {
    const onRemove = vi
      .fn()
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValueOnce({ bytesRemoved: 0, filesRemoved: 1 });
    await render({ onRemove });
    await manage("2");
    const confirm = button("确认卸载");
    await click(confirm);
    expect(button("确认卸载")).toBe(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.classList.contains("Disabled")).toBe(false);
    expect(
      container.querySelector(
        '[role="dialog"][aria-label^="管理指南："] [role="alert"]',
      )?.textContent,
    ).toContain("磁盘忙");
    await render({
      entries: [entry("1"), { ...entry("2"), cache: null }, entry("3")],
    });
    expect(button("确认清理残留").classList.contains("Disabled")).toBe(false);
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]')
        ?.textContent,
    ).toContain("可重试完成剩余离线文件的清理。");
    await click(button("取消"));
    await manage("2");
    const retry = button("确认清理残留");
    expect(retry.classList.contains("Disabled")).toBe(false);
    await click(retry);
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove.mock.calls.map(([target]) => target.guideId)).toEqual([
      "2",
      "2",
    ]);
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).toBeNull();
  });

  it("allows leftover cleanup while blocking busy or already completed removal", async () => {
    await render({ removeDisabled: true });
    await manage("1");
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]'),
    ).not.toBeNull();
    expect(button("确认卸载").classList.contains("Disabled")).toBe(true);
    await click(button("确认卸载"));
    await render({ removeDisabled: false, removed: true });
    await click(button("确认卸载"));
    expect(button("确认卸载").classList.contains("Disabled")).toBe(true);
    await click(button("取消"));
    await render({
      entries: [entry("1"), { ...entry("2"), cache: null }, entry("3")],
    });
    await manage("2");
    expect(
      container.querySelector('[role="dialog"][aria-label^="管理指南："]')
        ?.textContent,
    ).toContain("可重试完成剩余离线文件的清理");
    expect(button("确认清理残留").classList.contains("Disabled")).toBe(false);
    expect(props.onRemove).not.toHaveBeenCalled();
    await click(button("取消"));
    await manage("3");
    expect(button("确认卸载").classList.contains("Disabled")).toBe(false);
  });
});
