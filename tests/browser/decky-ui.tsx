import {
  createElement,
  createContext,
  forwardRef,
  useContext,
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
    if (props.onOKActionDescription)
      dom["data-ok-action"] = props.onOKActionDescription;
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
          "focusable",
        ].includes(name)
      )
        delete dom[name];
    }
    if (tag === "button") {
      // Steam's disabled buttons remain focusable; disabling suppresses activation.
      dom.type = "button";
      dom.disabled = false;
      if (props.disabled) {
        dom.className = `${props.className ?? ""} Disabled`;
        delete dom.onClick;
      }
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
        Enter: ["onOKButton", GamepadButton.OK],
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

// Structural stand-ins only. These classes do not reproduce Steam's proprietary stylesheet.
export const gamepadDialogClasses = {
  GamepadDialogContent: "fixture-dialog-content",
  FieldDescription: "fixture-field-description",
};
export const DialogButton = element("button");
export const DialogHeader = element("div");
export const DialogBody = element("div");
export const DialogBodyText = element("div");
export const DialogControlsSection = element("div");
export const DialogFooter = element("div");
export const Focusable = element("div");
export const Spinner = () => <span role="status">正在处理…</span>;
export const ReaderRoute = createContext({ appId: "", guideId: "" });
export const useParams = () => useContext(ReaderRoute);
export const TextField = ({
  label,
  onChange,
  value,
  focusOnMount,
  disabled,
}: Props) => (
  <input
    aria-label={label as string}
    onChange={onChange as ChangeEventHandler<HTMLInputElement>}
    value={value as string}
    autoFocus={Boolean(focusOnMount)}
    disabled={Boolean(disabled)}
  />
);
export const ProgressBar = ({ nProgress, indeterminate }: Props) => (
  <div
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Number(nProgress)}
    data-native-progress={indeterminate ? "indeterminate" : Number(nProgress)}
  />
);
export const ModalRoot = ({ children, onCancel }: Props) => (
  <form
    role="dialog"
    aria-modal="true"
    onSubmit={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === "Escape") (onCancel as (() => void) | undefined)?.();
    }}
  >
    {children}
  </form>
);
export const DropdownItem = ({
  label,
  selectedOption,
  rgOptions,
  disabled,
  onChange,
}: Props) => (
  <label>
    {label as string}
    <select
      aria-label={label as string}
      value={selectedOption as string}
      disabled={Boolean(disabled)}
      onChange={(event) =>
        (onChange as (option: { data: string }) => void)({
          data: event.target.value,
        })
      }
    >
      {(rgOptions as Array<{ data: string; label: string }>).map((option) => (
        <option key={option.data} value={option.data}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);
