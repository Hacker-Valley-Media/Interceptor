// Build the Interceptor WebUI to static files the runner bundles and serves over
// its loopback HTTP server: one Bun.build of index.html into flat, minified assets.
import { rm } from "node:fs/promises";

const outdir = process.argv[2] ?? new URL("./dist", import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [new URL("./index.html", import.meta.url).pathname],
  outdir,
  minify: true,
  sourcemap: "none",
  naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Interceptor WebUI built to ${outdir}`);
for (const o of result.outputs) console.log("  ", o.path.replace(outdir, "."));
