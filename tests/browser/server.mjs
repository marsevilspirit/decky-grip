import { fileURLToPath } from "node:url";
import { createViteServer } from "vitest/node";

const project = fileURLToPath(new URL("../../", import.meta.url));
const server = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./", import.meta.url)),
  cacheDir: `${project}node_modules/.vite/grip-browser`,
  resolve: {
    alias: [
      {
        find: /^@decky\/ui$/,
        replacement: fileURLToPath(new URL("./decky-ui.tsx", import.meta.url)),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [project] },
  },
});
await server.listen();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
