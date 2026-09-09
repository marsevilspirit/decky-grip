import {
  createElement,
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useState,
  type ChangeEventHandler,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { GamepadButton } from "@decky/ui/dist/components/FooterLegend.js";

// Only the Decky boundary is adapted. Layout, focus, events and observers are native Chromium.
export { GamepadButton };
type Props = Record<string, unknown> & { children?: ReactNode };
const element = (tag: "button" | "div") =>
  forwardRef<HTMLElement, Props>((props, ref) => {
    const dom = { ...props };
    if (props.preferredFocus) dom["data-native-preferred-focus"] = "true";
    if (props["flow-children"])
      dom["data-native-flow"] = props["flow-children"];
    if (props.focusable && dom.tabIndex === undefined) dom.tabIndex = 0;
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
      const result = (props[action[0]] as (event: unknown) => unknown)({
        target: event.target,
        currentTarget: event.currentTarget,
        detail: { button: action[1], is_repeat: event.repeat, source: 0 },
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
      if (result !== false) {
        event.preventDefault();
        event.stopPropagation();
      }
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
export const ScrollPanel = forwardRef<HTMLElement, Props>(
  ({ scrollDirection = "y", style, ...props }, ref) => (
    <Focusable
      {...props}
      ref={ref}
      data-native-scroll-panel={scrollDirection}
      style={{ overflowY: "auto", overflowX: "hidden", ...(style as object) }}
    />
  ),
);
export const Field = forwardRef<HTMLElement, Props>(
  (
    { label, description, disabled, highlightOnFocus: _highlight, ...props },
    ref,
  ) => (
    <Focusable
      {...props}
      ref={ref}
      data-native-field="true"
      className={[props.className, disabled && "Disabled"]
        .filter(Boolean)
        .join(" ")}
      onOKButton={props.onClick}
    >
      <div data-native-field-label>{label as ReactNode}</div>
      <div data-native-field-description>{description as ReactNode}</div>
      {props.children}
    </Focusable>
  ),
);
// Layout boundary only: Steam owns the real focus-driven marquee animation.
export const Marquee = ({ children }: Props) => (
  <div data-native-marquee>{children}</div>
);
// No installed Steam runtime in the fixture: the reader reports its compatibility fallback.
export const findModuleExport = () => undefined;
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
export const ModalRoot = ({
  children,
  onCancel,
  closeModal,
  ...props
}: Props) => (
  <form
    role="dialog"
    aria-label={props["aria-label"] as string}
    className={props.className as string}
    aria-modal="true"
    onSubmit={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat)
          ((onCancel ?? closeModal) as (() => void) | undefined)?.();
      }
    }}
  >
    {children}
  </form>
);
// A real browser modal supplies inertness, Tab bounds and return focus. This is a
// platform boundary, not a simulation of Steam's spatial FocusNav algorithm.
export function SimpleModal({ active = true, children }: Props) {
  const [dialog] = useState(() => document.createElement("dialog"));
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!active) return;
    dialog.setAttribute("role", "presentation");
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener("cancel", preventCancel);
    setReady(true);
    return () => {
      dialog.removeEventListener("cancel", preventCancel);
      dialog.close();
      dialog.remove();
      setReady(false);
    };
  }, [active, dialog]);
  useLayoutEffect(() => {
    if (
      !ready ||
      !active ||
      (document.activeElement !== dialog &&
        dialog.contains(document.activeElement))
    )
      return;
    (
      dialog.querySelector<HTMLElement>(
        '[data-native-preferred-focus="true"]',
      ) ?? dialog.querySelector<HTMLElement>('button, [tabindex="0"]')
    )?.focus();
  });
  return active && ready ? createPortal(children, dialog) : null;
}
function preventCancel(event: Event) {
  event.preventDefault(); // Content owns B/Escape, including destructive-action guards.
}
export function ConfirmModal(props: Props) {
  const cancel = (props.onCancel ?? props.closeModal) as () => void;
  return (
    <ModalRoot aria-label={props.strTitle} onCancel={cancel}>
      <DialogHeader>{props.strTitle as ReactNode}</DialogHeader>
      <DialogBodyText>{props.strDescription as ReactNode}</DialogBodyText>
      <DialogButton disabled={props.bOKDisabled} onClick={props.onOK}>
        {props.strOKButtonText as ReactNode}
      </DialogButton>
      <DialogButton
        disabled={props.bCancelDisabled}
        preferredFocus={props.focusButton === "secondary"}
        onClick={cancel}
      >
        {props.strCancelButtonText as ReactNode}
      </DialogButton>
    </ModalRoot>
  );
}
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
