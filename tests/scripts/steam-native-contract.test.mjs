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
});
