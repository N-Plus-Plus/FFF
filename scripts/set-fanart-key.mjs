// Production-only helper. Never run by build, local startup or tests.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
if (process.argv.slice(2).join(" ") !== "--apply") throw new Error("This modifies the live Worker. Separate approval and --apply are required.");
const vars = parseEnv(await readFile(".env.vars", "utf8"));
if (!vars.FANART_TV?.trim()) throw new Error("FANART_TV is missing from .env.vars.");
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "FANART_TV", "--name", "fff-api"], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(vars.FANART_TV.trim() + "\n");
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
