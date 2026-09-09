import { createElement, forwardRef, type ReactNode } from "react";

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
    return createElement(
      tag,
      { ...domProps, ...keyboard?.(props, tag), ref: gamepadRef(ref, props) },
      props.children as ReactNode,
    );
  });
}
