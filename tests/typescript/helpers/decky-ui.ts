import {
  createElement,
  forwardRef,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

import { gamepadRef } from "./decky-gamepad";

export interface MockDeckyProps {
  children?: ReactNode;
  [key: string]: unknown;
}

type KeyboardHandlers = {
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyUp?: (event: KeyboardEvent) => void;
};

// Share only DOM plumbing; each suite owns its keyboard-to-gamepad shortcuts.
export function mockDeckyElement(
  tag: "button" | "div",
  keyboard?: (props: MockDeckyProps, tag: "button" | "div") => KeyboardHandlers,
) {
  return forwardRef<HTMLElement, MockDeckyProps>((props, ref) => {
    const domProps = { ...props };
    for (const [name, value] of Object.entries(props)) {
      if (
        name.startsWith("onGamepad") ||
        name.endsWith("ActionDescription") ||
        [
          "children",
          "flow-children",
          "onButtonDown",
          "onButtonUp",
          "onOKButton",
          "onSecondaryButton",
          "onOptionsButton",
          "onCancel",
          "preferredFocus",
          "actionDescriptionMap",
          "focusClassName",
          "focusWithinClassName",
          "noFocusRing",
          "focusable",
        ].includes(name)
      )
        delete domProps[name];
      if (name === "onGamepadFocus") domProps.onFocus = value;
      if (name === "onGamepadBlur") domProps.onBlur = value;
    }
    for (const action of ["OK", "Cancel", "Secondary", "Options"]) {
      const label = props[`on${action}ActionDescription`];
      if (label) domProps[`data-${action.toLowerCase()}-action`] = label;
    }
    if (props.focusable !== undefined)
      domProps["data-native-focusable"] = props.focusable;
    if (props["flow-children"])
      domProps["data-native-flow"] = props["flow-children"];
    if (props.preferredFocus) domProps["data-native-preferred-focus"] = "true";
    return createElement(
      tag,
      { ...domProps, ...keyboard?.(props, tag), ref: gamepadRef(ref, props) },
      props.children as ReactNode,
    );
  });
}

// Structural test boundary only; Steam owns the real portal, focus tree and return stack.
export function mockSimpleModal({ active = true, children }: MockDeckyProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!active || !host.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const target =
      host.current.querySelector<HTMLElement>(
        '[data-native-preferred-focus="true"]',
      ) ?? host.current.querySelector<HTMLElement>('button, [tabindex="0"]');
    target?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [active]);
  return active
    ? createElement("div", { ref: host, "data-native-modal": true }, children)
    : null;
}

const Modal = mockDeckyElement("div", (props) => ({
  onKeyDown: (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) (props.onCancel as (() => void) | undefined)?.();
  },
}));
export function mockModalRoot(props: MockDeckyProps) {
  return createElement(Modal, {
    role: "dialog",
    "aria-label": props["aria-label"],
    className: props.className,
    onCancel: props.onCancel ?? props.closeModal,
    children: props.children,
  });
}

const ModalButton = mockDialogButton();
export function mockConfirmModal(props: MockDeckyProps) {
  return createElement(mockModalRoot, {
    "aria-label": props.strTitle,
    onCancel: props.onCancel ?? props.closeModal,
    children: [
      createElement("div", { key: "title" }, props.strTitle as ReactNode),
      createElement(
        "div",
        { key: "description" },
        props.strDescription as ReactNode,
      ),
      createElement(ModalButton, {
        key: "ok",
        disabled: props.bOKDisabled,
        onClick: props.onOK,
        children: props.strOKButtonText ?? "确定",
      }),
      createElement(ModalButton, {
        key: "cancel",
        disabled: props.bCancelDisabled,
        preferredFocus: props.focusButton === "secondary",
        onClick: props.onCancel ?? props.closeModal,
        children: props.strCancelButtonText ?? "取消",
      }),
    ],
  });
}

// Valve's DialogButton G (module 44351) marks Disabled and removes activation,
// but passes disabled:false to its HTML/gamepad button (90242 / 28869).
export function mockDialogButton(
  keyboard?: Parameters<typeof mockDeckyElement>[1],
) {
  const Button = mockDeckyElement("button", keyboard);
  return forwardRef<HTMLElement, MockDeckyProps>(
    ({ disabled, focusable, ...props }, ref) => {
      const handlers: MockDeckyProps = {};
      for (const name of [
        "onClick",
        "onPointerDown",
        "onPointerUp",
        "onPointerCancel",
        "onMouseDown",
        "onMouseUp",
        "onTouchStart",
        "onTouchEnd",
        "onTouchCancel",
        "onSubmit",
      ]) {
        const handler = props[name] as ((event: Event) => void) | undefined;
        handlers[name] =
          !disabled && handler
            ? (event: Event) => {
                event.stopPropagation();
                handler(event);
              }
            : undefined;
      }
      return createElement(Button, {
        type: "button",
        onOKActionDescription: disabled ? null : undefined,
        ...props,
        ...handlers,
        ref,
        disabled: false,
        "data-native-focusable": focusable,
        className: ["DialogButton", props.className, disabled && "Disabled"]
          .filter(Boolean)
          .join(" "),
      });
    },
  );
}
