import { readFile, readdir } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createWorker } from "../src/index.js";
import { createGoogleVerifier } from "../src/google-auth.js";
import assert from "node:assert/strict";

export async function fixture(origin = "https://wirewednesday.nissen.nexus", { beforeMigration, afterMigration } = {}) {
  const platform = await getPlatformProxy({ configPath: "wrangler.jsonc", persist: false });
  const env = { ...platform.env, APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "synthetic-client", ASSETS: { async fetch(request) {
    const url = new URL(request.url);
    if (url.search || request.headers.get("referer")) throw new Error("Asset query/referrer must be stripped.");
    const name = url.pathname.slice(1);
    try {
      const body = await readFile(`cloudflare/public/${name}`);
      const type = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "image/png";
      return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": type } });
    } catch { return new Response("Not found", { status: 404 }); }
  } } };
  let beforeAuthMigration;
  const preservationTables = ["app_users", "shows", "show_nominations", "user_show_rankings"];
  for (const name of (await readdir("cloudflare/migrations")).filter((n) => n.endsWith(".sql")).sort()) {
    await beforeMigration?.(name, env.DB);
    if (name === "0004_google_auth.sql") {
      await env.DB.prepare("INSERT INTO app_users(id,display_name,link_token_hash,token_issued_at,created_at,updated_at) VALUES('history','Historical fixture',?,'2026-01-01','2026-01-01','2026-01-01')").bind("0".repeat(64)).run();
      await env.DB.prepare("INSERT INTO shows(id,imdb_id,title,first_enrolled_by,created_at,updated_at) VALUES('history-show','tt90000009','Historical show','history','2026-01-01','2026-01-01')").run();
      await env.DB.prepare("INSERT INTO show_nominations VALUES('history','history-show','2026-01-01','2026-01-01',NULL)").run();
      await env.DB.prepare("INSERT INTO user_show_rankings VALUES('history','history-show',1,'2026-01-01')").run();
      beforeAuthMigration = await Promise.all(preservationTables.map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
    }
    const sql = (await readFile(`cloudflare/migrations/${name}`, "utf8")).replace(/^--.*$/gm, "");
    let statement = "", trigger = false;
    for (const line of sql.split(/\r?\n/)) {
      if (!line.trim()) continue;
      statement += line + "\n";
      if (/CREATE TRIGGER/i.test(line)) trigger = true;
      if (trigger && !/^END;/.test(line)) continue;
      if (trigger) { await env.DB.prepare(statement).run(); statement = ""; trigger = false; }
      else if (statement.trim().endsWith(";")) {
        for (const part of statement.split(";").filter((s) => s.trim())) await env.DB.prepare(part).run();
        statement = "";
      }
    }
    await afterMigration?.(name, env.DB);
    if (name === "0004_google_auth.sql") {
      const after = await Promise.all(preservationTables.map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
      assert.deepEqual(after, beforeAuthMigration, "Forward auth migration preserves all existing participant/nomination/ranking/show fields");
      // Remove only these disposable preservation fixtures before flow assertions.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_show_rankings WHERE user_id='history'"),
        env.DB.prepare("DELETE FROM show_nominations WHERE user_id='history'"),
        env.DB.prepare("DELETE FROM shows WHERE id='history-show'"),
        env.DB.prepare("DELETE FROM app_users WHERE id='history'")
      ]);
    }
  }
  for (const [id, name, admin, active] of [["a", "Participant A", 1, 1], ["b", "Participant B", 0, 1], ["c", "Inactive participant", 0, 0]]) {
    await env.DB.prepare("INSERT INTO app_users(id,display_name,link_token_hash,is_admin,is_active,token_issued_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, name, id.repeat(64), admin, active, "2026-01-01", "2026-01-01", "2026-01-01").run();
  }
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey); jwk.kid = "fixture"; jwk.alg = "RS256";
  const verifier = createGoogleVerifier(createLocalJWKSet({ keys: [jwk] }));
  const worker = createWorker({ verifyGoogle: verifier });
  const realFetch = globalThis.fetch;
  let providerFailure = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (providerFailure) throw new Error("Synthetic provider failure");
    if (parsed.origin === "https://api.tvmaze.com") return Response.json(parsed.pathname.includes("lookup")
      ? { id: 1, name: "Synthetic show", externals: { imdb: "tt90000001" }, image: null } : []);
    throw new Error("Unexpected external request in isolated test.");
  };
  async function credential(nonce, identity = { sub: "google-a", email: "a@example.test" }, claims = {}) {
    return new SignJWT({ email_verified: true, ...identity, nonce, ...claims }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(claims.iss || "https://accounts.google.com").setAudience(claims.aud || env.GOOGLE_CLIENT_ID)
      .setIssuedAt(claims.iat || Math.floor(Date.now()/1000)).setExpirationTime(claims.exp || "5m").sign(pair.privateKey);
  }
  const request = (path, { method = "GET", body, cookie = "", headers = {} } = {}) => worker.fetch(new Request(origin + path, {
    method, headers: { Cookie: cookie, ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  }), env);
  async function begin(_remember = true, cookie = "") {
    const response = await request("/auth/challenge", { method: "POST", body: {}, cookie });
    const { nonce } = await response.json();
    return { response, nonce, cookie: response.headers.getSetCookie().find((s) => s.includes("flow="))?.split(";")[0] };
  }
  async function signIn(value, overrides = {}, remember = true, cookie = "") {
    const flow = await begin(remember, cookie);
    const body = { credential: await credential(flow.nonce, value, overrides), remember };
    const response = await request("/auth/google", { method: "POST", cookie: flow.cookie, body });
    return { response, body, flow, cookie: response.headers.getSetCookie().find((s) => s.includes("session="))?.split(";")[0] || "" };
  }
  return { env, worker, request, begin, signIn, verifier, credential,
    failProvider(value) { providerFailure = value; },
    async dispose() { globalThis.fetch = realFetch; await platform.dispose(); } };
}
