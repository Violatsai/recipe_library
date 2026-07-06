import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundle popup/options to extension/dist/ and copy the static files.
 *  Load `extension/dist` as the unpacked extension in Chrome. */

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/popup.ts"), join(here, "src/options.ts")],
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: false,
});

for (const f of ["manifest.json"]) copyFileSync(join(here, f), join(dist, f));
for (const f of ["popup.html", "options.html"]) copyFileSync(join(here, "src", f), join(dist, f));

console.log("built extension → extension/dist (load this folder as unpacked)");
