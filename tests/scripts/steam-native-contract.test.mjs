import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";

// Read Valve's installed implementation, not a copied fixture or a reimplementation.
const steamUiDirectory =
  process.env.GRIP_STEAM_UI_DIR ??
  join(
    homedir(),
    "Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/steamui",
  );
// This is the locator used by the installed @decky/ui ProgressBar export.
const progressLocator = '.ProgressBar,"standard"==';
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function nativeFunction(source, marker) {
  const position = source.indexOf(marker);
  assert.ok(position >= 0, `Steam implementation no longer matches ${marker}`);
  const declarations = [
    ...source.slice(0, position).matchAll(/function(?:\s+[$\w]+)?\(/g),
  ];
  const start = declarations.at(-1)?.index;
  assert.notEqual(start, undefined, `Missing function around ${marker}`);
  // Let JavaScript's parser find the complete function, including nested braces/templates.
  for (
    let end = source.indexOf("}", position);
    end >= 0 && end < start + 8192;
    end = source.indexOf("}", end + 1)
  ) {
    const code = source.slice(start, end + 1);
    try {
      new Script(`(${code})`);
      return code;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  assert.fail(`Could not extract the bounded Steam function around ${marker}`);
}

function symbols(code, pattern) {
  const match = pattern.exec(code);
  assert.ok(match, `Steam boundary no longer matches ${pattern}`);
  return match.slice(1);
}

function bind(context, [namespace, member], value) {
  (context[namespace] ??= {})[member] = value;
}

const element = (type, props) => ({ type, props });
const classNames = (...names) => names.filter(Boolean).join(" ");
function render(code, context, input) {
  return new Script(`(${code})(input)`).runInNewContext(
    { ...context, input },
    { timeout: 1000 },
  );
}

test("installed Valve components retain the GRIP native UI contracts", async (t) => {
  if (!existsSync(steamUiDirectory)) {
    assert.ok(
      !process.env.GRIP_STEAM_UI_DIR,
      "GRIP_STEAM_UI_DIR does not exist",
    );
    t.skip(
      "Steam UI is not installed; set GRIP_STEAM_UI_DIR to verify a local Valve bundle (no download)",
    );
    return;
  }
  let bundle;
  for (const name of readdirSync(steamUiDirectory)
    .filter((name) => name.endsWith(".js"))
    .sort()) {
    const path = join(steamUiDirectory, name);
    const source = readFileSync(path, "utf8");
    if (source.includes(progressLocator)) {
      bundle = { path, source };
      break;
    }
  }
  assert.ok(
    bundle,
    "Installed Steam no longer matches Decky's ProgressBar locator",
  );
  t.diagnostic(`Valve bundle: ${bundle.path}; SHA256 ${sha256(bundle.source)}`);

  await t.test(
    "ProgressBar uses percent values and needs zero for indeterminate mode",
    () => {
      const code = nativeFunction(bundle.source, progressLocator);
      const context = {};
      bind(context, symbols(code, /\b([$\w]+)\.(jsx)\b/), element);
      bind(
        context,
        symbols(code, /className:\(0,([$\w]+)\.([$\w]+)\)/),
        classNames,
      );
      const [styles] = symbols(code, /\b([$\w]+)\.ProgressBar\b/);
      context[styles] = Object.fromEntries(
        ["ProgressBar", "StandardMargin", "Percent", "Indeterminate"].map(
          (name) => [name, name],
        ),
      );
      bind(
        context,
        symbols(
          code,
          /\(0,([$\w]+)\.([$\w]+)\)\("#ProgressBar_ValueUnknown"\)/,
        ),
        (key) => key,
      );

      for (const progress of [0, 50, 100]) {
        const output = render(code, context, { nProgress: progress });
        assert.equal(output.props.role, "progressbar");
        assert.equal(output.props["aria-valuenow"], progress);
        assert.equal(output.props.children.props.style.width, `${progress}%`);
        assert.equal(output.props.children.props.style.transition, "1s ease");
        assert.ok(
          !output.props.children.props.className.includes("Indeterminate"),
        );
      }
      const pending = render(code, context, {
        indeterminate: true,
        nProgress: 0,
      });
      assert.equal(
        pending.props["aria-valuetext"],
        "#ProgressBar_ValueUnknown",
      );
      assert.equal(pending.props.children.props.style.width, undefined);
      assert.ok(
        pending.props.children.props.className.includes("Indeterminate"),
      );
      const missingProgress = render(code, context, { indeterminate: true });
      assert.ok(
        !missingProgress.props.children.props.className.includes(
          "Indeterminate",
        ),
      );
      // Valve does not clamp this input; GRIP must supply its bounded percentage.
      assert.equal(
        render(code, context, { nProgress: 150 }).props.children.props.style
          .width,
        "150%",
      );
      t.diagnostic(`ProgressBar function SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "DialogButton disabled removes activation without setting HTML disabled or dropping focusable",
    () => {
      const code = nativeFunction(bundle.source, '.disabled&&"Disabled"');
      const context = {};
      bind(context, symbols(code, /\b([$\w]+)\.(jsxs)\b/), element);
      bind(
        context,
        symbols(code, /\(0,([$\w]+)\.([$\w]+)\)\(e\.className/),
        classNames,
      );
      bind(
        context,
        symbols(code, /const [$\w]+=\(0,([$\w]+)\.([$\w]+)\)\(\)/),
        () => ({ strButtonClassName: "native-button" }),
      );
      bind(context, symbols(code, /\.jsxs\)\(([$\w]+)\.([$\w]+),/), "button");
      const onClick = () => {};
      const onSecondaryButton = () => {};
      const disabled = render(code, context, {
        disabled: true,
        focusable: true,
        onClick,
        onSecondaryButton,
      });
      assert.equal(disabled.type, "button");
      assert.ok(disabled.props.className.split(" ").includes("Disabled"));
      assert.equal(disabled.props.disabled, false);
      assert.equal(disabled.props.focusable, true);
      assert.equal(disabled.props.onClick, undefined);
      assert.equal(disabled.props.onSecondaryButton, onSecondaryButton);
      const active = render(code, context, {
        disabled: false,
        focusable: true,
        onClick,
      });
      assert.ok(!active.props.className.split(" ").includes("Disabled"));
      assert.equal(active.props.disabled, false);
      assert.equal(active.props.focusable, true);
      assert.equal(typeof active.props.onClick, "function");
      const ariaOnly = render(code, context, {
        "aria-disabled": true,
        focusable: true,
        onClick,
      });
      assert.ok(!ariaOnly.props.className.split(" ").includes("Disabled"));
      assert.equal(typeof ariaOnly.props.onClick, "function");
      t.diagnostic(`DialogButton function SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "Field owns row highlighting and activation, but disabled still needs an action guard",
    () => {
      const code = nativeFunction(
        bundle.source,
        "spacingBetweenLabelAndChild:",
      );
      assert.ok(code.includes("scrollIntoViewWhenChildFocused"));
      const context = {};
      const [jsx] = symbols(code, /\b([$\w]+)\.jsxs\b/);
      context[jsx] = { jsx: element, jsxs: element };
      const [react] = symbols(code, /\b([$\w]+)\.useRef\(/);
      context[react] = {
        useRef: (current) => ({ current }),
        useCallback: (fn) => fn,
      };
      bind(
        context,
        symbols(code, /className:\(0,([$\w]+)\.([$\w]+)\)/),
        classNames,
      );
      const [styles] = symbols(code, /\b([$\w]+)\(\)\.Field\b/);
      context[styles] = () => new Proxy({}, { get: (_, name) => name });
      bind(
        context,
        symbols(code, /,[$\w]+=\(0,([$\w]+)\.([$\w]+)\)\(\),P=/),
        () => false,
      );
      bind(
        context,
        symbols(code, /const r=\(0,([$\w]+)\.([$\w]+)\)\(\)/),
        () => ({}),
      );
      bind(
        context,
        symbols(code, /\(0,([$\w]+)\.([$\w]+)\)\(ie,e\.navRef\)/),
        (ref) => ref,
      );
      bind(
        context,
        symbols(
          code,
          /return\(0,[$\w]+\.jsxs\)\(([$\w]+)\.([$\w]+),\{focusable:/,
        ),
        "focusable",
      );
      const [labelId] = symbols(code, /id:([$\w]+)\(r\)/);
      const [descriptionId] = symbols(code, /accessibilityId:([$\w]+)\(r\)/);
      context[labelId] = (id) => `${id}_Label`;
      context[descriptionId] = (id) => `${id}_Description`;
      const [description] = symbols(code, /d&&\(0,[$\w]+\.jsx\)\(([$\w]+),/);
      context[description] = "description";
      let activations = 0;
      const onClick = () => {
        activations++;
      };
      for (const disabled of [false, true]) {
        const field = render(code, context, {
          label: "Guide title",
          description: "Author and reading position",
          focusable: true,
          disabled,
          onClick,
        });
        assert.equal(field.type, "focusable");
        assert.equal(field.props.focusable, true);
        assert.equal(field.props.scrollIntoViewWhenChildFocused, true);
        assert.ok(field.props.className.includes("HighlightOnFocus"));
        assert.equal(
          field.props.className.split(" ").includes("Disabled"),
          disabled,
        );
        assert.equal(field.props.onClick, onClick);
        field.props.onActivate(new Event("activate"));
      }
      // Native Field's disabled prop is presentation only, unlike DialogButton.
      assert.equal(activations, 2);
      t.diagnostic(`Field function SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "ScrollPanel wraps the native focus ring without adding an A-to-enter level",
    () => {
      const code = nativeFunction(bundle.source, '{case"x":');
      const context = {};
      bind(context, symbols(code, /\b([$\w]+)\.(jsx)\b/), element);
      const [styles] = symbols(code, /\b([$\w]+)\(\)\.ScrollX\b/);
      context[styles] = () => ({
        ScrollPanel: "ScrollPanel",
        ScrollX: "ScrollX",
        ScrollY: "ScrollY",
        ScrollBoth: "ScrollBoth",
      });
      const [classes] = symbols(code, /className:([$\w]+)\(\)\(/);
      context[classes] = () => classNames;
      bind(
        context,
        symbols(code, /\.jsx\)\(([$\w]+)\.([$\w]+),\{\.\.\./),
        "native-focusable",
      );
      bind(
        context,
        symbols(code, /children:\(0,[$\w]+\.jsx\)\(([$\w]+)\.([$\w]+),/),
        "native-focus-ring",
      );
      const resizeRef = { current: null };
      const registeredNavRef = { current: null };
      bind(
        context,
        symbols(code, /navRef:[$\w]+\}=\(0,([$\w]+)\.([$\w]+)\)\(\)/),
        () => ({ ref: resizeRef, navRef: registeredNavRef }),
      );
      bind(
        context,
        symbols(code, /\(0,([$\w]+)\.([$\w]+)\)\([$\w]+,[$\w]+\.navRef\)/),
        (...refs) =>
          (value) => {
            for (const ref of refs) {
              if (typeof ref === "function") ref(value);
              else if (ref) ref.current = value;
            }
          },
      );
      const forwardedRef = { current: null };
      const navRef = { current: null };
      const onCancel = () => {};
      const onOptionsButton = () => {};
      const children = { type: "guide-list" };
      const panel = new Script(
        `(${code})(input, forwardedRef)`,
      ).runInNewContext(
        {
          ...context,
          forwardedRef,
          input: {
            scrollDirection: "y",
            "flow-children": "column",
            className: "guide-switcher-list",
            style: { maxHeight: "65vh" },
            onCancel,
            onOptionsButton,
            navRef,
            children,
          },
        },
        { timeout: 1000 },
      );
      assert.equal(panel.type, "native-focusable");
      assert.equal(
        panel.props.className,
        "guide-switcher-list ScrollPanel ScrollY",
      );
      assert.equal(panel.props["flow-children"], "column");
      assert.equal(panel.props.style.maxHeight, "65vh");
      assert.equal(panel.props.onCancel, onCancel);
      assert.equal(panel.props.onOptionsButton, onOptionsButton);
      for (const prop of ["focusable", "onOKButton", "onCancelButton"]) {
        assert.equal(Object.hasOwn(panel.props, prop), false);
      }
      assert.equal(panel.props.children.type, "native-focus-ring");
      assert.equal(panel.props.children.props.children, children);
      const domNode = {};
      panel.props.ref(domNode);
      assert.equal(forwardedRef.current, domNode);
      assert.equal(resizeRef.current, domNode);
      const navNode = {};
      panel.props.navRef(navNode);
      assert.equal(navRef.current, navNode);
      assert.equal(registeredNavRef.current, navNode);
      t.diagnostic(`ScrollPanel function SHA256 ${sha256(code)}`);
    },
  );

  const libraryPath = join(steamUiDirectory, "library.js");
  const library = readFileSync(libraryPath, "utf8");
  t.diagnostic(
    `Valve navigation bundle: ${libraryPath}; SHA256 ${sha256(library)}`,
  );

  await t.test(
    "a null native action legend hides inheritance only on its focused branch",
    () => {
      const start = library.indexOf(
        "BuildConsolidatedActionDescriptionMap(e){",
      );
      const end = library.indexOf("AddChild(e){", start);
      assert.ok(start >= 0 && end > start && end - start < 1024);
      const code = library.slice(start, end);
      const consolidate = new Script(
        `({${code}}).BuildConsolidatedActionDescriptionMap`,
      ).runInNewContext({});
      const node = (actions, parent = null) => ({
        m_Properties: { actionDescriptionMap: actions },
        m_Parent: parent,
        m_Tree: { GetParentEmbeddedNavTree: () => null },
        BuildConsolidatedActionDescriptionMap: consolidate,
      });
      const parent = node({ 1: "Read", 2: "Return", 3: "Contents" });
      const viewport = node({ 1: null, 3: undefined }, parent);
      assert.deepEqual(viewport.BuildConsolidatedActionDescriptionMap({}), {
        1: null,
        2: "Return",
        3: "Contents",
      });
      const sibling = node({ 1: "Previous image" }, parent);
      assert.deepEqual(sibling.BuildConsolidatedActionDescriptionMap({}), {
        1: "Previous image",
        2: "Return",
        3: "Contents",
      });
      t.diagnostic(`Action legend consolidation SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "native input owns A-to-keyboard registration, not B or X, and cleans up its listeners",
    () => {
      const code = nativeFunction(library, "keyboard got blur event");
      const wrapCode = nativeFunction(
        library,
        "!1!==e(t)&&(t.stopPropagation(),t.preventDefault())",
      );
      const wrap = new Script(`(${wrapCode})`).runInNewContext({});
      const context = {};
      const effects = [];
      const [react] = symbols(code, /\b([$\w]+)\.useRef\(/);
      context[react] = {
        useRef: (current) => ({ current }),
        useCallback: (callback) => callback,
        useLayoutEffect: (effect) => effects.push(effect),
      };
      const calls = [];
      const keyboard = {
        ShowVirtualKeyboard: () => {
          calls.push("show");
        },
        SetAsCurrentVirtualKeyboardTarget: () => calls.push("target"),
        HideVirtualKeyboard: () => calls.push("hide"),
        DelayHideVirtualKeyboard: () => calls.push("delay-hide"),
        BIsActive: () => true,
      };
      const [factory] = symbols(code, /const u=([$\w]+)\(c\.current\)/);
      let keyboardProps;
      context[factory] = (props) => {
        keyboardProps = props;
        return keyboard;
      };
      bind(context, symbols(code, /m=\(0,([$\w]+)\.([$\w]+)\)/), (fn) => fn);
      bind(
        context,
        symbols(code, /useLayoutEffect\(\(\)=>\(\(0,([$\w]+)\.([$\w]+)\)/),
        (ref, value) => {
          ref.current = value;
        },
      );
      const listen = (type, logical) => (target, handler) => {
        const callback = logical ? wrap(handler) : handler;
        target.addEventListener(type, callback);
        return () => target.removeEventListener(type, callback);
      };
      bind(
        context,
        symbols(code, /\(0,([$\w]+)\.([$\w]+)\)\(e,u\.ShowVirtualKeyboard\)/),
        listen("vgp_onok", true),
      );
      bind(
        context,
        symbols(code, /\(0,([$\w]+)\.([$\w]+)\)\(e,d\)/),
        listen("vgp_onblur", false),
      );
      const input = new EventTarget();
      const document = { activeElement: input, hasFocus: () => true };
      const handle = {};
      const ref = new Script(`(${code})({}, handle)`).runInNewContext(
        { ...context, document, handle },
        { timeout: 1000 },
      );
      const cleanup = ref(input);
      const effectCleanup = effects[0]();
      const dispatch = (type) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
      };
      dispatch("focus");
      assert.deepEqual(calls, ["target"]);
      assert.equal(keyboardProps.BIsElementValidForInput(), true);
      const activate = dispatch("vgp_onok");
      assert.deepEqual(calls, ["target", "show"]);
      assert.equal(activate.defaultPrevented, true);
      assert.equal(activate.cancelBubble, true);
      dispatch("click");
      assert.deepEqual(calls, ["target", "show", "show"]);
      for (const type of ["vgp_oncancel", "vgp_onsecondaryaction"]) {
        const event = dispatch(type);
        assert.equal(event.defaultPrevented, false);
        assert.equal(event.cancelBubble, false);
      }
      dispatch("vgp_onblur");
      assert.equal(calls.at(-1), "delay-hide");
      handle.current.HideVirtualKeyboard();
      assert.equal(calls.at(-1), "hide");
      cleanup();
      effectCleanup();
      const callCount = calls.length;
      for (const type of ["focus", "click", "vgp_onok", "vgp_onblur"])
        dispatch(type);
      assert.equal(calls.length, callCount);
      assert.equal(handle.current, null);
      t.diagnostic(`Native input keyboard hook SHA256 ${sha256(code)}`);
    },
  );

  await t.test("the active native keyboard consumes B to hide itself", () => {
    const code = nativeFunction(bundle.source, 'navID:"virtual keyboard"');
    const [navRef, cancel, manager] = symbols(
      code,
      /\.jsx\)\([$\w]+\.[$\w]+,\{navID:"virtual keyboard",onGlobalButtonDown:[$\w]+,navTreeRef:([$\w]+),virtualFocus:!0,className:[^;]+?,onCancelButton:(\(\)=>([$\w]+)\.SetVirtualKeyboardHidden\(\))/,
    );
    // The effect activates the same tree that owns this B callback.
    assert.ok(
      code.includes(`${navRef}.current.Activate()`),
      "The keyboard no longer activates its cancellation-owning navigation tree",
    );
    let hides = 0;
    const callback = new Script(`(${cancel})`).runInNewContext({
      [manager]: {
        SetVirtualKeyboardHidden: () => {
          hides++;
        },
      },
    });
    const wrap = nativeFunction(
      library,
      "!1!==e(t)&&(t.stopPropagation(),t.preventDefault())",
    );
    const event = new Event("vgp_oncancel", { cancelable: true });
    new Script(`(${wrap})(callback)(event)`).runInNewContext(
      { callback, event },
      { timeout: 1000 },
    );
    assert.equal(hides, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.cancelBubble, true);
    t.diagnostic(`Native keyboard container SHA256 ${sha256(code)}`);
  });

  await t.test(
    "the native keyboard maps X press and release to Backspace, not clear-all",
    () => {
      const start = bundle.source.indexOf(
        "OnGamepadButtonDown(e){switch(e.detail.button){case gt.pR.OK",
      );
      const up = bundle.source.indexOf("OnGamepadButtonUp(e){", start);
      const end = bundle.source.indexOf("DispatchEventByDataKey(e,t){", up);
      assert.ok(start >= 0 && up > start && end > up && end - start < 8192);
      const code = bundle.source.slice(start, end);
      const context = {};
      bind(
        context,
        symbols(code, /case ([$\w]+)\.([$\w]+)\.SECONDARY:/),
        new Proxy({}, { get: (_, key) => key }),
      );
      bind(
        context,
        symbols(
          code,
          /e\.detail\.source==([$\w]+)\.([$\w]+)\.KEYBOARD_SIMULATOR/,
        ),
        { KEYBOARD_SIMULATOR: "simulator" },
      );
      const handlers = new Script(
        `(class {${code}}).prototype`,
      ).runInNewContext(context, { timeout: 1000 });
      const calls = [];
      const keyboard = {
        DispatchEventByDataKey: (...args) => calls.push(args),
        StartBackspaceTimer: () => calls.push("start-timer"),
        CancelBackpaceTimer: () => calls.push("cancel-timer"),
        DismissBackpaceTimer: () => calls.push("dismiss-timer"),
      };
      const event = (repeat, source = "gamepad") => ({
        detail: { button: "SECONDARY", source, is_repeat: repeat },
      });
      handlers.OnGamepadButtonDown.call(keyboard, event(false));
      handlers.OnGamepadButtonDown.call(keyboard, event(true));
      assert.deepEqual(calls, [
        ["Backspace", true],
        "start-timer",
        ["Backspace", true],
        "start-timer",
      ]);
      handlers.OnGamepadButtonUp.call(keyboard, event(false));
      assert.deepEqual(calls.slice(-3), [
        ["Backspace", false],
        "cancel-timer",
        "dismiss-timer",
      ]);
      const count = calls.length;
      handlers.OnGamepadButtonDown.call(keyboard, event(false, "simulator"));
      assert.equal(calls.length, count);
      t.diagnostic(`Native keyboard X handlers SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "TextField pointer clear dispatches input, not a gamepad X action",
    () => {
      const start = bundle.source.indexOf("OnClearClick(e){");
      const end = bundle.source.indexOf("CheckProps(e){", start);
      assert.ok(start >= 0 && end > start && end - start < 1024);
      const code = bundle.source.slice(start, end);
      class Input extends EventTarget {
        text = "guide search";
        get value() {
          return this.text;
        }
        set value(value) {
          this.text = value;
        }
      }
      const input = new Input();
      const changes = [];
      input.addEventListener("input", (event) => {
        changes.push({ value: input.value, bubbles: event.bubbles });
      });
      const clear = () =>
        new Script(
          `({${code}}).OnClearClick.call({m_elInput: input})`,
        ).runInNewContext(
          { input, Event, window: { HTMLInputElement: Input } },
          { timeout: 1000 },
        );
      clear();
      assert.equal(input.value, "");
      assert.deepEqual(changes, [{ value: "", bubbles: true }]);
      clear();
      assert.equal(changes.length, 1);
      t.diagnostic(`TextField clear method SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "native scrolling owns the step, repeat target and boundary handoff",
    () => {
      const code = nativeFunction(bundle.source, "??30)/100");
      assert.ok(code.includes("ScrollOnGamepadDirection top:"));
      const context = {};
      const [react] = symbols(code, /\b([$\w]+)\.useRef\(/);
      context[react] = {
        useRef: (current) => ({ current }),
        useCallback: (callback) => callback,
      };
      const buttons = Object.fromEntries(
        ["DIR_UP", "DIR_DOWN", "DIR_LEFT", "DIR_RIGHT"].map((name) => [
          name,
          name,
        ]),
      );
      bind(context, symbols(code, /case ([$\w]+)\.([$\w]+)\.DIR_UP:/), buttons);
      const [log] = symbols(code, /return ([$\w]+)\(`ScrollOnGamepadDirection/);
      context[log] = () => {};
      const animations = [];
      bind(
        context,
        symbols(code, /new ([$\w]+)\.([$\w]+)\(e\.current/),
        class {
          constructor(element, target, options) {
            Object.assign(this, { element, target, options });
            animations.push(this);
          }
          Start() {
            this.started = true;
          }
          Cancel() {
            this.canceled = true;
          }
        },
      );
      const writes = [];
      const view = {
        scrollTop: 0,
        scrollHeight: 5000,
        clientHeight: 1000,
        scrollLeft: 0,
        scrollWidth: 1000,
        clientWidth: 1000,
        scrollTo(options) {
          writes.push(options);
          if (options.top !== undefined) this.scrollTop = options.top;
          if (options.left !== undefined) this.scrollLeft = options.left;
        },
      };
      const ref = { current: view };
      const hook = new Script(`(${code})`).runInNewContext(context, {
        timeout: 1000,
      });
      const direction = (button) => ({
        detail: { button },
        defaultPrevented: false,
      });
      const auto = hook(ref, "auto");
      assert.equal(auto(direction(buttons.DIR_UP)), false);
      assert.equal(auto(direction(buttons.DIR_LEFT)), false);
      assert.equal(auto(direction(buttons.DIR_DOWN)), true);
      assert.equal(writes[0].top, 300);
      assert.equal(writes[0].behavior, "auto");
      view.scrollTop = 3900;
      assert.equal(auto(direction(buttons.DIR_DOWN)), true);
      assert.equal(view.scrollTop, 4000);
      assert.equal(auto(direction(buttons.DIR_DOWN)), false);
      assert.equal(
        auto({ ...direction(buttons.DIR_UP), defaultPrevented: true }),
        false,
      );
      assert.equal(
        hook(ref, "auto", undefined, () => false)(direction(buttons.DIR_UP)),
        false,
      );
      view.scrollTop = 0;
      const smooth = hook(ref);
      smooth(direction(buttons.DIR_DOWN));
      smooth({
        ...direction(buttons.DIR_DOWN),
        detail: { button: buttons.DIR_DOWN, is_repeat: true },
      });
      assert.equal(animations.length, 2);
      assert.equal(animations[0].element, view);
      assert.equal(animations[0].target.scrollTop, 300);
      assert.equal(animations[0].started, true);
      assert.equal(animations[0].canceled, true);
      assert.equal(animations[1].target.scrollTop, 600);
      assert.equal(animations[1].options.timing, "linear");
      assert.equal(animations[1].options.msDuration, 300);
      ref.current = null;
      assert.equal(smooth(direction(buttons.DIR_DOWN)), false);
      t.diagnostic(`Native scrolling hook SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "native logical input propagates only when the handler returns false",
    () => {
      const code = nativeFunction(
        library,
        "!1!==e(t)&&(t.stopPropagation(),t.preventDefault())",
      );
      for (const result of [undefined, true, false]) {
        const event = new Event("vgp_ondirection", { cancelable: true });
        const handler = () => result;
        new Script(`(${code})(handler)(event)`).runInNewContext(
          { handler, event },
          { timeout: 1000 },
        );
        assert.equal(event.defaultPrevented, result !== false);
        assert.equal(event.cancelBubble, result !== false);
      }
      t.diagnostic(`Logical event wrapper SHA256 ${sha256(code)}`);
    },
  );

  await t.test(
    "the registered DOM focus listener transfers native navigation focus",
    () => {
      const start = library.indexOf("OnDOMFocus(e){");
      const end = library.indexOf("OnDOMBlur(e){", start);
      assert.ok(start >= 0 && end > start && end - start < 8192);
      const code = library.slice(start, end);
      const context = {};
      bind(
        context,
        symbols(code, /TransferFocus\(([$\w]+)\.([$\w]+)\.BROWSER/),
        { BROWSER: "browser-source" },
      );
      const [log] = symbols(code, /return ([$\w]+)\("Browser gave node focus/);
      context[log] = () => {};
      const transfers = [];
      const descendant = {};
      const node = {
        BHasFocus: () => false,
        GetFocusable: () => "self",
        FindFocusableDescendant: () => descendant,
        m_Tree: { TransferFocus: (...args) => transfers.push(args) },
      };
      const focus = () =>
        new Script(`({${code}}).OnDOMFocus.call(node, {})`).runInNewContext(
          { ...context, node },
          { timeout: 1000 },
        );
      focus();
      assert.deepEqual(transfers, [["browser-source", node]]);
      node.GetFocusable = () => "children";
      focus();
      assert.deepEqual(transfers.at(-1), ["browser-source", descendant]);
      node.BHasFocus = () => true;
      focus();
      assert.equal(transfers.length, 2);
      t.diagnostic(`OnDOMFocus method SHA256 ${sha256(code)}`);
    },
  );
});
