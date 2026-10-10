import { mkdir, copyFile, readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Explicit allowlist: never publish the repository, exports, tooling or secrets.
export const publicFiles = ["index.html", "login.html", "login.js", "bootstrap.js", "api.js", "style.css", "app.js", "config.js", "store.js", "providers.js", "ranking.js", "wire-wednesday.png"];
const root = new URL("../../", import.meta.url);
const destination = new URL("../public/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const entry of await readdir(destination, { withFileTypes: true })) {
  if (entry.name === "vendor" && entry.isDirectory()) continue;
  if (!entry.isFile()) throw new Error("Unexpected directory in generated public assets; inspect it manually.");
  if (!publicFiles.includes(entry.name)) await unlink(new URL(entry.name, destination));
}
for (const name of publicFiles) await copyFile(new URL(name === "wire-wednesday.png" ? "assets/wire-wednesday.png" : name, root), new URL(name, destination));
const vendorFiles = {
  "lucide.min.js": "node_modules/lucide/dist/umd/lucide.min.js",
  "lucide-LICENSE.txt": "node_modules/lucide/LICENSE",
  "lexend-deca-LICENSE.txt": "node_modules/@fontsource/lexend-deca/LICENSE"
};
for (const weight of [400, 600, 700, 800]) vendorFiles[`lexend-deca-latin-${weight}.woff2`] = `node_modules/@fontsource/lexend-deca/files/lexend-deca-latin-${weight}-normal.woff2`;
const vendor = new URL("vendor/", destination);
await mkdir(vendor, { recursive: true });
for (const entry of await readdir(vendor, { withFileTypes: true })) {
  if (!entry.isFile()) throw new Error("Unexpected directory in vendor assets.");
  if (!Object.hasOwn(vendorFiles, entry.name)) await unlink(new URL(entry.name, vendor));
}
for (const [name, source] of Object.entries(vendorFiles)) await copyFile(new URL(source, root), new URL(name, vendor));
console.log(`Prepared ${publicFiles.length + Object.keys(vendorFiles).length} allowlisted local assets in ${fileURLToPath(destination)}`);
