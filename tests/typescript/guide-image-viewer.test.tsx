// @vitest-environment happy-dom

import { GamepadButton } from "@decky/ui";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GuideImageViewer,
  type ReaderPreviewImage,
} from "../../src/components/GuideImageViewer";
import { gamepadEvent, type GamepadHandler } from "./helpers/decky-gamepad";

vi.mock("@decky/ui", async () => {
  const { GamepadButton } = await import("./helpers/decky-gamepad");
  const { mockDeckyElement, mockDialogButton } =
    await import("./helpers/decky-ui");
  return {
    DialogButton: mockDialogButton(),
    DialogBodyText: mockDeckyElement("div"),
    Focusable: mockDeckyElement("div"),
    GamepadButton,
    gamepadDialogClasses: { GamepadDialogContent: "native-dialog-content" },
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
    handler: GamepadHandler,
    value: GamepadButton,
    repeat = false,
  ) => {
    const event = gamepadEvent(handler, value, repeat);
    vi.spyOn(event, "preventDefault");
    vi.spyOn(event, "stopPropagation");
    act(() => element.dispatchEvent(event));
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
    expect(button("放大").classList.contains("Disabled")).toBe(true);
    for (let i = 0; i < 40; i++)
      gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_LEFT);
    expect(img().style.width).toBe("20px");
    expect(button("缩小").classList.contains("Disabled")).toBe(true);
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
    expect(button("上一张").classList.contains("Disabled")).toBe(true);
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
    expect(button("下一张").classList.contains("Disabled")).toBe(true);
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

  it("uses the same bounded canvas and toolbar navigation for keyboard arrows", () => {
    render({ image: tall, images: [first, tall] });
    const outerKey = vi.fn();
    document.body.addEventListener("keydown", outerKey);
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(viewport().scrollTop).toBe(120);
    key("ArrowUp");
    expect(viewport().scrollTop).toBe(0);
    key("ArrowLeft");
    expect(viewport().scrollLeft).toBe(0);
    key("+");
    key("ArrowRight");
    expect(viewport().scrollLeft).toBe(296);
    key("0");
    expect(Number.parseFloat(img().style.height)).toBeCloseTo(568);
    key("ArrowDown");
    expect(document.activeElement).toBe(button("适应屏幕"));
    key("ArrowRight");
    expect(document.activeElement).toBe(button("返回正文"));
    key("ArrowRight");
    expect(document.activeElement).toBe(button("返回正文"));
    key("ArrowUp");
    expect(document.activeElement).toBe(viewport());
    document.body.removeEventListener("keydown", outerKey);
    expect(outerKey).not.toHaveBeenCalled();
  });

  it("switches images with PageUp/PageDown, preserves modifier shortcuts and ignores repeats", () => {
    render({ images: [first, tall] });
    expect(key("PageUp").defaultPrevented).toBe(true);
    expect(img().src).toBe(first.src);
    key("PageDown", { repeat: true });
    expect(img().src).toBe(first.src);
    key("PageDown");
    expect(img().src).toBe(tall.src);
    expect(img().style.width).toBe("768px");
    expect(document.activeElement).toBe(viewport());
    key("PageDown");
    expect(img().src).toBe(tall.src);
    key("PageUp");
    expect(img().src).toBe(first.src);
    expect(key("+", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(img().style.width).toBe("768px");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the canvas before a focused zoom control becomes disabled", () => {
    render();
    button("放大").focus();
    for (
      let index = 0;
      index < 20 && !button("放大").classList.contains("Disabled");
      index++
    )
      act(() => button("放大").click());
    expect(button("放大").classList.contains("Disabled")).toBe(true);
    expect(document.activeElement).toBe(viewport());
    button("缩小").focus();
    for (
      let index = 0;
      index < 40 && !button("缩小").classList.contains("Disabled");
      index++
    )
      act(() => button("缩小").click());
    expect(button("缩小").classList.contains("Disabled")).toBe(true);
    expect(document.activeElement).toBe(viewport());
    key("Tab");
    expect(document.activeElement).toBe(button("放大"));
  });

  it("shows drag feedback, tracks only the captured pointer and clamps panning at image edges", () => {
    render({ image: tall, images: [first, tall] });
    const capture = vi.fn();
    viewport().setPointerCapture = capture;
    viewport().hasPointerCapture = vi.fn(() => true);
    viewport().releasePointerCapture = vi.fn();
    const pointer = (type: string, pointerId: number, x: number, y: number) =>
      act(() =>
        viewport().dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId,
            clientX: x,
            clientY: y,
          }),
        ),
      );
    button("适应屏幕").focus();
    pointer("pointerdown", 1, 200, 400);
    expect(capture).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(viewport());
    expect(viewport().dataset.dragging).toBe("true");
    expect(viewport().style.cursor).toBe("grabbing");
    pointer("pointermove", 2, 200, 0);
    expect(viewport().scrollTop).toBe(0);
    pointer("pointerup", 2, 200, 0);
    expect(viewport().dataset.dragging).toBe("true");
    pointer("pointermove", 1, -200, -5000);
    expect(viewport().scrollTop).toBe(1704);
    expect(viewport().scrollLeft).toBe(0);
    pointer("pointermove", 1, 200, 1000);
    expect(viewport().scrollTop).toBe(0);
    pointer("pointercancel", 1, 200, 1000);
    expect(viewport().dataset.dragging).toBe("false");
    expect(viewport().style.cursor).toBe("grab");
    pointer("pointermove", 1, 200, 0);
    expect(viewport().scrollTop).toBe(0);
    pointer("pointerdown", 3, 200, 400);
    key("PageUp");
    expect(img().src).toBe(first.src);
    expect(viewport().dataset.dragging).toBe("false");
  });

  it("ends pointer capture before zooming or fitting so the old drag cannot jump the image back", () => {
    render({ image: tall });
    viewport().setPointerCapture = vi.fn();
    viewport().hasPointerCapture = vi.fn(() => true);
    const release = vi.fn();
    viewport().releasePointerCapture = release;
    const pointer = (type: string, y: number) =>
      act(() =>
        viewport().dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: 200,
            clientY: y,
          }),
        ),
      );
    viewport().scrollTop = 500;
    pointer("pointerdown", 400);
    gamepad(dialog(), "onButtonDown", GamepadButton.BUMPER_RIGHT);
    expect(viewport().dataset.dragging).toBe("false");
    expect(release).toHaveBeenCalledExactlyOnceWith(1);
    const zoomedTop = viewport().scrollTop;
    expect(zoomedTop).toBeCloseTo(900);
    pointer("pointermove", 300);
    expect(viewport().scrollTop).toBe(zoomedTop);

    pointer("pointerdown", 400);
    gamepad(dialog(), "onSecondaryButton", GamepadButton.SECONDARY);
    expect(viewport().dataset.dragging).toBe("false");
    expect(release).toHaveBeenCalledTimes(2);
    expect(viewport().scrollTop).toBe(0);
    pointer("pointermove", 300);
    expect(viewport().scrollTop).toBe(0);
  });

  it("consumes B and Y, ignoring repeated B and keeping Y from switching the guide", () => {
    render();
    const escaped = vi.fn();
    host.addEventListener("onCancel", escaped);
    host.addEventListener("onOptionsButton", escaped);
    const source = button("放大");
    // The child has no B/Y handler: the event must bubble to the viewer,
    // whose stopPropagation keeps it away from the reader outside the modal.
    gamepad(source, "onCancel", GamepadButton.CANCEL, true);
    expect(onClose).not.toHaveBeenCalled();
    const cancel = gamepad(source, "onCancel", GamepadButton.CANCEL);
    expect(cancel.target).toBe(source);
    expect(cancel.defaultPrevented).toBe(true);
    expect(cancel.preventDefault).toHaveBeenCalledOnce();
    expect(cancel.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    const options = gamepad(source, "onOptionsButton", GamepadButton.OPTIONS);
    expect(options.defaultPrevented).toBe(true);
    expect(options.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(escaped).not.toHaveBeenCalled();
    host.removeEventListener("onCancel", escaped);
    host.removeEventListener("onOptionsButton", escaped);
  });

  it("keeps keyboard focus within the viewer, skips disabled controls and needs no image list", () => {
    render({ images: [first, small] });
    expect(button("上一张").classList.contains("Disabled")).toBe(true);
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

  it("uses native dialog styling without overriding focus, press, disabled or animation feedback", () => {
    render();
    expect(dialog().classList.contains("native-dialog-content")).toBe(true);
    expect(host.querySelector("style")).toBeNull();
    for (const element of [
      dialog(),
      viewport(),
      ...host.querySelectorAll("button"),
    ]) {
      expect(element.style.background).toBe("");
      expect(element.style.color).toBe("");
      expect(element.style.outline).toBe("");
      expect(element.style.animation).toBe("");
      expect(element.style.transition).toBe("");
    }
    expect(viewport().style.cursor).toBe("grab");
    expect(dialog().textContent).toContain("38%");
    expect(dialog().textContent).toContain("L1 / R1 缩放");
    expect(dialog().textContent).toContain("X 适屏 · B 返回");
  });
});
