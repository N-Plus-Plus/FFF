// Production helper: never invoked by build/tests. Requires explicit --apply
// and separate operator approval; sends only the client ID through stdin.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
if (process.argv.slice(2).join(" ") !== "--apply") throw new Error("This modifies the live Worker. Separate approval and --apply are required.");
const vars = parseEnv(await readFile(".env.vars", "utf8"));
if (!vars.GOOGLE_CLIENT_ID?.trim()) throw new Error("GOOGLE_CLIENT_ID is missing from .env.vars.");
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "GOOGLE_CLIENT_ID", "--name", "fff-api"], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(vars.GOOGLE_CLIENT_ID.trim() + "\n");
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code || 0; });
