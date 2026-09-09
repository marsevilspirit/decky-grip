import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

test("leaves plugin chrome, focus feedback and animation to Steam UI", () => {
  const directory = new URL("../../src/components/", import.meta.url);
  const presentation = new Set([
    "color",
    "background",
    "backgroundColor",
    "boxShadow",
    "borderRadius",
    "opacity",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "animation",
    "transition",
    "outline",
    "accentColor",
  ]);
  const overrides = [];
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".tsx"),
  )) {
    const source = readFileSync(new URL(file, directory), "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        presentation.has(node.name.getText(ast))
      )
        overrides.push(`${file}: ${node.name.getText(ast)}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.doesNotMatch(
      source,
      /#[\da-f]{3,8}\b|rgba?\(|@keyframes|::selection|:focus\b|:active\b|:hover\b|!important/i,
      file,
    );
    assert.doesNotMatch(source, /<(?:button|progress)\b/, file);
  }
  assert.deepEqual(overrides, []);
});
