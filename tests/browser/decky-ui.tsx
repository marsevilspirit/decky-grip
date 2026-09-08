import {
  createElement,
  forwardRef,
  type ChangeEventHandler,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { GamepadButton } from "@decky/ui/dist/components/FooterLegend.js";

// Only the Decky boundary is adapted. Layout, focus, events and observers are native Chromium.
export { GamepadButton };
type Props = Record<string, unknown> & { children?: ReactNode };
const element = (tag: "button" | "div") =>
  forwardRef<HTMLElement, Props>((props, ref) => {
    const dom = { ...props };
    for (const name of Object.keys(dom)) {
      if (
        name.startsWith("onGamepad") ||
        name.endsWith("ActionDescription") ||
        [
          "onButtonDown",
          "onButtonUp",
          "onCancel",
          "onOKButton",
          "onOptionsButton",
          "onSecondaryButton",
          "preferredFocus",
          "actionDescriptionMap",
          "flow-children",
          "focusClassName",
          "focusWithinClassName",
          "noFocusRing",
        ].includes(name)
      )
        delete dom[name];
    }
    dom.onFocus = (event: FocusEvent<HTMLElement>) => {
      (
        props.onFocus as ((event: FocusEvent<HTMLElement>) => void) | undefined
      )?.(event);
      (
        props.onGamepadFocus as
          ((event: FocusEvent<HTMLElement>) => void) | undefined
      )?.(event);
    };
    dom.onBlur = (event: FocusEvent<HTMLElement>) => {
      (
        props.onBlur as ((event: FocusEvent<HTMLElement>) => void) | undefined
      )?.(event);
      (
        props.onGamepadBlur as
          ((event: FocusEvent<HTMLElement>) => void) | undefined
      )?.(event);
    };
    dom.onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      (
        props.onKeyDown as
          ((event: KeyboardEvent<HTMLElement>) => void) | undefined
      )?.(event);
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      // F2/F3 stand in for Decky Y/X; they are not physical-controller acceptance evidence.
      const mapping: Record<string, [string, number]> = {
        F2: ["onOptionsButton", GamepadButton.OPTIONS],
        F3: ["onSecondaryButton", GamepadButton.SECONDARY],
        Escape: ["onCancel", GamepadButton.CANCEL],
        ArrowUp: ["onGamepadDirection", GamepadButton.DIR_UP],
        ArrowDown: ["onGamepadDirection", GamepadButton.DIR_DOWN],
        ArrowLeft: ["onGamepadDirection", GamepadButton.DIR_LEFT],
        ArrowRight: ["onGamepadDirection", GamepadButton.DIR_RIGHT],
      };
      const action = mapping[event.key];
      if (!action || !props[action[0]]) return;
      (props[action[0]] as (event: unknown) => void)({
        target: event.target,
        currentTarget: event.currentTarget,
        detail: { button: action[1], is_repeat: event.repeat, source: 0 },
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
    };
    return createElement(tag, { ...dom, ref }, props.children as ReactNode);
  });

export const Button = element("button");
export const Focusable = element("div");
export const Spinner = () => <span role="status">正在处理…</span>;
export const useParams = () => ({ appId: "1113000", guideId: "3414883877" });
export const TextField = ({ label, onChange, value, focusOnMount }: Props) => (
  <input
    aria-label={label as string}
    onChange={onChange as ChangeEventHandler<HTMLInputElement>}
    value={value as string}
    autoFocus={Boolean(focusOnMount)}
  />
);
