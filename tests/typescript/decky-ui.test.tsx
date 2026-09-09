// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { GamepadButton, gamepadEvent } from "./helpers/decky-gamepad";
import { mockDeckyElement, mockDialogButton } from "./helpers/decky-ui";

it("shares DOM focus, legends and refs without replacing native gamepad propagation", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Button = mockDeckyElement("button");
  const Focusable = mockDeckyElement("div");
  const ref = createRef<HTMLElement>();
  const focus = vi.fn();
  const bubble = vi.fn();
  const cancel = vi.fn((event: CustomEvent) => {
    expect(event.target).toBe(ref.current);
    expect(event.currentTarget).toBe(ref.current);
    expect(event.detail.is_repeat).toBe(true);
    event.preventDefault();
    event.stopPropagation();
  });
  const replacement = vi.fn(() => false);
  const render = (onCancel: (event: CustomEvent) => void) =>
    act(() =>
      root.render(
        <Focusable onCancel={bubble}>
          <Button
            ref={ref}
            aria-label="指南"
            className="guide"
            onCancel={onCancel}
            onGamepadFocus={focus}
            onOKActionDescription="阅读"
            onSecondaryActionDescription="管理"
            onCancelActionDescription="返回"
            onOptionsActionDescription="切换"
            preferredFocus
            flow-children="column"
          >
            正文
          </Button>
        </Focusable>,
      ),
    );
  let button: HTMLElement | null = null;
  try {
    render(cancel);
    button = ref.current!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.className).toBe("guide");
    expect(button.getAttribute("aria-label")).toBe("指南");
    expect(button.textContent).toBe("正文");
    expect(button.dataset).toMatchObject({
      okAction: "阅读",
      secondaryAction: "管理",
      cancelAction: "返回",
      optionsAction: "切换",
    });
    expect(button.hasAttribute("flow-children")).toBe(false);
    expect(button.hasAttribute("preferredfocus")).toBe(false);
    act(() => button!.focus());
    expect(focus).toHaveBeenCalledOnce();
    const event = gamepadEvent("onCancel", GamepadButton.CANCEL, true);
    act(() => button!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(bubble).not.toHaveBeenCalled();

    render(replacement);
    expect(ref.current).toBe(button);
    act(() =>
      button!.dispatchEvent(gamepadEvent("onCancel", GamepadButton.CANCEL)),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
    expect(bubble).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
  expect(ref.current).toBeNull();
  button!.dispatchEvent(gamepadEvent("onCancel", GamepadButton.CANCEL));
  expect(replacement).toHaveBeenCalledOnce();
});

it("models Steam's disabled visuals and blocked activation without disabling its focus target", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("form");
  document.body.append(host);
  const root = createRoot(host);
  const Button = mockDialogButton();
  const ref = createRef<HTMLElement>();
  const click = vi.fn();
  const submit = vi.fn();
  host.addEventListener("submit", submit);
  const render = (disabled: boolean) =>
    act(() =>
      root.render(
        <Button ref={ref} disabled={disabled} focusable onClick={click}>
          确认
        </Button>,
      ),
    );
  try {
    render(false);
    const target = ref.current as HTMLButtonElement;
    target.focus();
    render(true);
    expect(ref.current).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(target.disabled).toBe(false);
    expect(target.type).toBe("button");
    expect(target.classList.contains("Disabled")).toBe(true);
    expect(target.dataset.nativeFocusable).toBe("true");
    expect(target.hasAttribute("aria-disabled")).toBe(false);
    act(() => target.click());
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    render(false);
    expect(target.classList.contains("Disabled")).toBe(false);
    expect(document.activeElement).toBe(target);
    act(() => target.click());
    expect(click).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
