import { rm } from "node:fs/promises";
import { rollup } from "rollup";

import config from "../rollup.config.js";

try {
  await rm(new URL("../dist/", import.meta.url), {
    force: true,
    recursive: true,
  });

  const { output, watch: _watch, ...inputOptions } = config;
  const bundle = await rollup(inputOptions);

  try {
    await bundle.write(output);
  } finally {
    await bundle.close();
  }

  // Some Decky Rollup plugin versions retain background handles after a
  // successful one-shot build. Output has been written and closed above.
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
