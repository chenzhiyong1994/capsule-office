import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "site-dist");
if (relative(root, output) !== "site-dist") {
  throw new Error("Refusing to clean an output directory outside the project.");
}
await rm(output, { recursive: true, force: true });

// The desktop renderer already has a browser-only preview API. Bundle that same
// UI under /demo/ while keeping the landing page independent of Electron.
await build({
  root,
  base: "./",
  build: { outDir: resolve(output, "demo"), emptyOutDir: true },
});
await mkdir(output, { recursive: true });
await cp(resolve(root, "site"), output, { recursive: true });
await writeFile(resolve(output, ".nojekyll"), "");
console.log("Project homepage and browser demo built in site-dist/.");
