import { rollup } from "rollup";

import config from "../rollup.config.js";

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
