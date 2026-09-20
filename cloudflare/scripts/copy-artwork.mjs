/* Read public, already-retained Supabase artwork and upload the same keys to R2. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const input = process.argv[2];
if (!input) throw new Error("Usage: node cloudflare/scripts/copy-artwork.mjs <private-export.json>");
const envelope = JSON.parse((await readFile(input, "utf8")).replace(/^\uFEFF/, ""));
const source = envelope.snapshot || envelope.rows?.[0]?.snapshot || envelope;
const keys = [...new Set((source.shows || []).flatMap((show) => [show.poster_storage_path, show.card_art_storage_path]).filter((key) => /^(posters|card-art)\/tt\d{7,10}\.(jpg|jpeg|png|webp)$/i.test(key || "")))];
const root = await mkdtemp(join(tmpdir(), "fff-artwork-"));
let copied = 0;
try {
  for (const key of keys) {
    const response = await fetch(`https://ckzarkkjosckoegswakf.supabase.co/storage/v1/object/public/show-posters/${key}`);
    if (!response.ok) { console.error(`Skipped unavailable artwork: ${key}`); continue; }
    const path = join(root, `${copied}.bin`);
    await writeFile(path, new Uint8Array(await response.arrayBuffer()));
    const command = `npx.cmd wrangler r2 object put fff-artwork/${key} --file ${path} --remote`;
    await exec("cmd.exe", ["/d", "/s", "/c", command], { windowsHide: true });
    copied += 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ expected: keys.length, copied }));
