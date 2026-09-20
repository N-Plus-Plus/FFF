/* Local-only bearer-token diagnostic. It never writes or displays the supplied token or stored hashes. */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { sha256LowerHex } from "../src/auth.js";

const exportPath = process.argv[2] || "cloudflare/private-fff-export.json";
if (!process.stdin.isTTY) throw new Error("Run this script in an interactive terminal.");
const token = await readHidden("Paste existing FFF token (input hidden): ");
try {
  const source = unwrap(JSON.parse((await readFile(exportPath, "utf8")).replace(/^\uFEFF/, "")));
  const sourceRows = source.app_users || [];
  const d1Rows = await d1Users();
  const sourceById = new Map(sourceRows.map((row) => [row.id, row.link_token_hash]));
  const d1ById = new Map(d1Rows.map((row) => [row.id, row.link_token_hash]));
  const exact = sourceRows.length === 4 && sourceRows.every((row) => d1ById.get(row.id) === row.link_token_hash);
  console.log(`source-to-d1-hashes: ${exact ? "EXACT MATCH (4/4)" : "MISMATCH"}`);
  const variants = {
    "current-worker-hash": token,
    "legacy-hash": token,
    "trimmed-token-hash": token.trim(),
    "URL-decoded-token-hash": decode(token),
    "URLSearchParams-token-hash": new URLSearchParams(`u=${token}`).get("u") || "",
    "lowercase-token-hash": token.toLowerCase(),
    "base64url-decoded-bytes-hash": base64UrlBytes(token)
  };
  for (const [name, value] of Object.entries(variants)) {
    const hash = value instanceof Uint8Array ? await hashBytes(value) : await sha256LowerHex(value);
    console.log(`${name}: ${sourceByIdHas(sourceById, hash) ? "MATCH" : "NO MATCH"}`);
  }
} finally {
  token.fill?.(0);
}

function unwrap(value) { return value.snapshot || value.rows?.[0]?.snapshot || value; }
function sourceByIdHas(users, hash) { return [...users.values()].includes(hash); }
function decode(value) { try { return decodeURIComponent(value); } catch { return value; } }
function base64UrlBytes(value) { try { const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); return Uint8Array.from(Buffer.from(base64, "base64")); } catch { return new Uint8Array(); } }
async function hashBytes(bytes) { const digest = await crypto.subtle.digest("SHA-256", bytes); return Buffer.from(digest).toString("hex"); }
function readHidden(prompt) {
  process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stdout.write("\n"); resolve(value); };
    const onData = (chunk) => { for (const char of chunk) { if (char === "\u0003") { process.stdin.setRawMode(false); reject(new Error("Cancelled.")); return; } if (char === "\r" || char === "\n") return done(); if (char === "\u007f" || char === "\b") value = value.slice(0, -1); else value += char; } };
    process.stdin.on("data", onData);
  });
}
function d1Users() {
  const command = "npx.cmd wrangler d1 execute fff --remote --json --command \"SELECT id,link_token_hash FROM app_users ORDER BY id\"";
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], { windowsHide: true }); let out = "", err = "";
    child.stdout.on("data", (data) => out += data); child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => { if (code) return reject(new Error(`D1 query failed (${code}): ${err}`)); try { resolve(JSON.parse(out)[0].results); } catch { reject(new Error("D1 query returned invalid JSON.")); } });
  });
}
