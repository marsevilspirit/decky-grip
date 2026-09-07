// @vitest-environment happy-dom

import { GamepadButton, type GamepadEvent } from "@decky/ui";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GuideImageViewer,
  type ReaderPreviewImage,
} from "../../src/components/GuideImageViewer";

const mock = vi.hoisted(() => ({
  props: new WeakMap<HTMLElement, Record<string, unknown>>(),
}));

vi.mock("@decky/ui", async () => {
  const { createElement, forwardRef } = await import("react");
  const element = (tag: "button" | "div") =>
    forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
      const domProps = { ...props };
      for (const key of Object.keys(domProps)) {
        if (
          key.startsWith("onGamepad") ||
          key.endsWith("ActionDescription") ||
          [
            "onButtonDown",
            "onButtonUp",
            "onSecondaryButton",
            "onOptionsButton",
            "onCancel",
            "preferredFocus",
            "actionDescriptionMap",
            "focusClassName",
            "focusWithinClassName",
            "noFocusRing",
          ].includes(key)
        )
          delete domProps[key];
      }
      return createElement(
        tag,
        {
          ...domProps,
          ref: (node: HTMLElement | null) => {
            if (node) mock.props.set(node, props);
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          },
        },
        props.children as ReactNode,
      );
    });
  return {
    Button: element("button"),
    Focusable: element("div"),
    GamepadButton: {
      OK: 1,
      CANCEL: 2,
      SECONDARY: 3,
      OPTIONS: 4,
      BUMPER_LEFT: 5,
      BUMPER_RIGHT: 6,
      TRIGGER_LEFT: 7,
      TRIGGER_RIGHT: 8,
      DIR_UP: 9,
      DIR_DOWN: 10,
      DIR_LEFT: 11,
      DIR_RIGHT: 12,
    },
  };
});

const first: ReaderPreviewImage = {
  src: "blob:first",
  alt: "第一张",
  width: 2000,
  height: 1000,
};
const tall: ReaderPreviewImage = {
  src: "blob:tall",
  alt: "长图",
  width: 2000,
  height: 6000,
};
const small: ReaderPreviewImage = {
  src: "blob:small",
  alt: "小图",
  width: 100,
  height: 50,
};

describe("full-screen image viewer interaction", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
  const viewport = () =>
    host.querySelector<HTMLElement>('[aria-label="图片移动区域"]')!;
  const img = () => host.querySelector("img")!;
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    )!;
  const render = (
    props: Partial<ComponentProps<typeof GuideImageViewer>> = {},
  ) => {
    act(() =>
      root.render(
        <GuideImageViewer image={first} onClose={onClose} {...props} />,
      ),
    );
  };
  const gamepad = (
    element: HTMLElement,
    handler: string,
    value: GamepadButton,
    repeat = false,
  ) => {
    const event = {
      detail: { button: value, is_repeat: repeat, source: 0 },
      currentTarget: element,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const callback = mock.props.get(element)?.[handler];
    expect(callback).toBeTypeOf("function");
    act(() =>
      (callback as (event: GamepadEvent) => void)(
        event as unknown as GamepadEvent,
      ),
    );
    return event;
  };
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    act(() => document.activeElement!.dispatchEvent(event));
    return event;
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onClose = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("zooms immediately around the center with LB/RB, ignores repeats and fits with X", () => {
    render();
    expect(img().style.width).toBe("768px");
    expect(document.activeElement).toBe(viewport());
    const right = gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    expect(right.preventDefault).toHaveBeenCalledOnce();
    expect(right.stopPropagation).toHaveBeenCalledOnce();
    expect(img().style.width).toBe("1152px");
    expect(viewport().scrollLeft).toBe(176);
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT, true);
    expect(img().style.width).toBe("1152px");
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_LEFT);
    expect(img().style.width).toBe("768px");
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    gamepad(dialog(), "onSecondaryButton", GamepadButton.SECONDARY, true);
    expect(img().style.width).toBe("1152px");
    const fit = gamepad(dialog(), "onSecondaryButton", GamepadButton.SECONDARY);
    expect(fit.stopPropagation).toHaveBeenCalledOnce();
    expect(img().style.width).toBe("768px");
    expect(viewport().scrollLeft).toBe(0);
    expect(img().style.transition).toBe("");
  });

  it("opens long images at readable width and switches back to fit-screen height with X", () => {
    render({ image: tall });
    expect(img().style.width).toBe("768px");
    expect(img().style.height).toBe("2304px");
    viewport().scrollTop = 500;
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    expect(viewport().scrollTop).toBeCloseTo(900);
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_LEFT);
    expect(viewport().scrollTop).toBeCloseTo(500);
    gamepad(dialog(), "onSecondaryButton", GamepadButton.SECONDARY);
    expect(Number.parseFloat(img().style.height)).toBeCloseTo(568);
    expect(viewport().scrollTop).toBe(0);
  });

  it("clamps zoom and disables the corresponding controls at both limits", () => {
    render();
    for (let i = 0; i < 20; i++)
      gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    expect(img().style.width).toBe("16000px");
    expect(button("放大").disabled).toBe(true);
    for (let i = 0; i < 40; i++)
      gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_LEFT);
    expect(img().style.width).toBe("20px");
    expect(button("缩小").disabled).toBe(true);
  });

  it("pans to the image edge, then enters the toolbar, whose Up returns to the canvas", () => {
    render();
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_RIGHT);
    expect(viewport().scrollLeft).toBe(296);
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_RIGHT);
    expect(viewport().scrollLeft).toBeCloseTo(352);
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_DOWN);
    expect(document.activeElement).toBe(button("适应屏幕"));
    const toolbar = host.querySelector<HTMLElement>(".grip-image-toolbar")!;
    gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_UP);
    expect(document.activeElement).toBe(viewport());
    render({ image: tall });
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_DOWN);
    expect(viewport().scrollTop).toBe(120);
    expect(document.activeElement).toBe(viewport());
    viewport().scrollTop = 1704;
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_DOWN);
    expect(document.activeElement).toBe(button("适应屏幕"));
  });

  it("switches among supplied visible images by LT/RT and buttons without repeats or boundary leakage", () => {
    render({ images: [first, tall, small, first] });
    expect(button("上一张").disabled).toBe(true);
    expect(dialog().textContent).toContain("1 / 3");
    const edge = gamepad(dialog(), "onButtonDown", GamepadButton.TRIGGER_LEFT);
    expect(edge.stopPropagation).toHaveBeenCalledOnce();
    expect(img().src).toBe(first.src);
    gamepad(dialog(), "onButtonDown", GamepadButton.TRIGGER_RIGHT, true);
    expect(img().src).toBe(first.src);
    gamepad(dialog(), "onButtonDown", GamepadButton.TRIGGER_RIGHT);
    expect(img().src).toBe(tall.src);
    expect(img().style.width).toBe("768px");
    act(() => button("下一张").click());
    expect(img().src).toBe(small.src);
    expect(img().style.width).toBe("100px");
    expect(button("下一张").disabled).toBe(true);
    expect(dialog().textContent).toContain("3 / 3");
    const end = gamepad(dialog(), "onButtonDown", GamepadButton.TRIGGER_RIGHT);
    expect(end.preventDefault).toHaveBeenCalledOnce();
    expect(end.stopPropagation).toHaveBeenCalledOnce();
    expect(img().src).toBe(small.src);
    act(() => button("上一张").click());
    expect(img().src).toBe(tall.src);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("resets failure, zoom, scroll and focus when switching images or replacing the initial image", () => {
    render({ images: [first, tall, small] });
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    act(() => img().dispatchEvent(new Event("error")));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    act(() => button("下一张").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(img().src).toBe(tall.src);
    expect(img().style.width).toBe("768px");
    expect(viewport().scrollLeft).toBe(0);
    expect(viewport().scrollTop).toBe(0);
    expect(document.activeElement).toBe(viewport());
    render({ image: small, images: [first, tall, small] });
    expect(img().src).toBe(small.src);
    expect(img().style.width).toBe("100px");
    expect(viewport().scrollTop).toBe(0);
  });

  it("handles real keyboard +/- and Escape on both canvas and toolbar without closing the reader", () => {
    render();
    const outerKey = vi.fn();
    document.body.addEventListener("keydown", outerKey);
    expect(key("+").defaultPrevented).toBe(true);
    expect(img().style.width).toBe("1152px");
    button("适应屏幕").focus();
    key("-");
    expect(img().style.width).toBe("768px");
    key("=", { repeat: true });
    expect(img().style.width).toBe("768px");
    expect(key("Escape").defaultPrevented).toBe(true);
    document.body.removeEventListener("keydown", outerKey);
    expect(onClose).toHaveBeenCalledOnce();
    expect(outerKey).not.toHaveBeenCalled();
  });

  it("consumes B and Y, ignoring repeated B and keeping Y from switching the guide", () => {
    render();
    gamepad(dialog(), "onCancel", GamepadButton.CANCEL, true);
    expect(onClose).not.toHaveBeenCalled();
    const cancel = gamepad(dialog(), "onCancel", GamepadButton.CANCEL);
    expect(cancel.preventDefault).toHaveBeenCalledOnce();
    expect(cancel.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    const options = gamepad(dialog(), "onOptionsButton", GamepadButton.OPTIONS);
    expect(options.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus within the viewer, skips disabled controls and needs no image list", () => {
    render({ images: [first, small] });
    expect(button("上一张").disabled).toBe(true);
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button("下一张"));
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(viewport());
    key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("返回正文"));
    key("Tab");
    expect(document.activeElement).toBe(viewport());
    render();
    expect(button("上一张")).toBeUndefined();
    expect(button("下一张")).toBeUndefined();
    expect(img().src).toBe(first.src);
  });

  it("keeps toolbar gamepad navigation inside the viewer and skips disabled image controls", () => {
    render({ images: [first, small] });
    gamepad(viewport(), "onGamepadDirection", GamepadButton.DIR_DOWN);
    expect(document.activeElement).toBe(button("适应屏幕"));
    const toolbar = host.querySelector<HTMLElement>(".grip-image-toolbar")!;
    gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_RIGHT);
    expect(document.activeElement).toBe(button("返回正文"));
    gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_RIGHT);
    expect(document.activeElement).toBe(button("返回正文"));
    const edge = gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_DOWN);
    expect(edge.stopPropagation).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button("返回正文"));
    for (let i = 0; i < 8; i++)
      gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_LEFT);
    expect(document.activeElement).toBe(button("下一张"));
    gamepad(toolbar, "onGamepadDirection", GamepadButton.DIR_UP);
    expect(document.activeElement).toBe(viewport());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("provides visible focus and press feedback, with animations gated by motion preference", () => {
    render();
    const css = host.querySelector("style")!.textContent!;
    expect(css).toContain(":focus-visible");
    expect(css).toContain(".grip-image-control:active");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toMatch(/no-preference[^]*transition:[^]*animation:/);
    expect(dialog().textContent).toContain("38%");
    expect(dialog().textContent).toContain("L1 / R1 缩放");
    expect(dialog().textContent).toContain("X 适屏 · B 返回");
  });
});
