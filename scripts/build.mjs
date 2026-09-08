import { rollup } from "rollup";
import { readFile } from "node:fs/promises";
import ts from "typescript";

import config from "../rollup.config.js";

const { output, watch: _watch, ...inputOptions } = config;
const bundle = await rollup(inputOptions);

try {
  await bundle.write(output);
} finally {
  await bundle.close();
}

// A fixed DOM-only extractor, shipped locally for the temporary Steam CEF page.
const renderer = await rollup({
  input: "src/import/heybox.ts",
  plugins: [
    {
      name: "standalone-typescript",
      async load(id) {
        if (!id.endsWith(".ts")) return null;
        return ts.transpileModule(await readFile(id, "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
      },
    },
  ],
});
try {
  await renderer.write({
    file: "dist/heybox-render.js",
    format: "iife",
    name: "GRIPHeyboxRenderer",
  });
} finally {
  await renderer.close();
}

// Some Decky Rollup plugin versions retain background handles after a
// successful one-shot build. Output has been written and closed above.
process.exit(0);
