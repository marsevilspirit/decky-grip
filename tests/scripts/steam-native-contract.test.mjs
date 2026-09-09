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

  const libraryPath = join(steamUiDirectory, "library.js");
  const library = readFileSync(libraryPath, "utf8");
  t.diagnostic(
    `Valve navigation bundle: ${libraryPath}; SHA256 ${sha256(library)}`,
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
