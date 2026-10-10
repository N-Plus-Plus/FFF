import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { sha256LowerHex } from "./auth.js";

const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5000 });
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SHORT_SESSION_SECONDS = 12 * 60 * 60;
export const authError = (status, message) => Object.assign(new Error(message), { status });
const json = (value) => Response.json(value);
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const instant = () => new Date().toISOString();

export function appOrigin(env) {
  const url = new URL(env.APP_ORIGIN || "https://wirewednesday.nissen.nexus");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
      (url.protocol !== "https:" && !isLoopback(url))) throw authError(503, "Authentication configuration is invalid.");
  return url.origin;
}
const isLoopback = (url) => ["localhost", "127.0.0.1"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
export function localDemo(request, env) {
  const url = new URL(request.url);
  return env.LOCAL_DEMO === "true" && isLoopback(url) && url.origin === appOrigin(env);
}
export function sameOrigin(request, env) {
  const origin = appOrigin(env);
  if (new URL(request.url).origin !== origin || request.headers.get("Origin") !== origin ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") throw authError(403, "Use the Wire Wednesday application origin.");
}
function cookieName(env, kind) {
  return `${isLoopback(new URL(appOrigin(env))) ? "ww-local-" : "__Host-ww-"}${kind}`;
}
function cookie(env, kind, value, maxAge) {
  const secure = isLoopback(new URL(appOrigin(env))) && appOrigin(env).startsWith("http:") ? "" : "; Secure";
  return `${cookieName(env, kind)}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
}
function readCookie(request, env, kind) {
  const name = cookieName(env, kind) + "=";
  const values = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim()).filter((s) => s.startsWith(name));
  const value = values.length === 1 ? values[0].slice(name.length) : "";
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export async function authenticate(request, env) {
  const token = readCookie(request, env, "session");
  if (!token) throw authError(401, "Sign in to Wire Wednesday to continue.");
  const user = await env.DB.prepare(`SELECT u.id,u.display_name,u.is_admin,u.is_active FROM auth_sessions s
    JOIN participant_google_auth a ON a.user_id=s.user_id AND a.google_sub=s.google_sub
    JOIN app_users u ON u.id=a.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1 AND u.is_active=1`)
    .bind(await sha256LowerHex(token), instant()).first();
  if (!user) throw authError(401, "Your session expired or access was withdrawn. Sign in again.");
  return user;
}
export function createGoogleVerifier(jwks = keys) {
  return async (credential, audience, nonce) => {
    try {
      const { payload } = await jwtVerify(credential, jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"], audience, algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "email", "email_verified", "nonce"]
      });
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 ||
          typeof payload.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(payload.email) ||
          payload.email_verified !== true || payload.nonce !== nonce ||
          typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 60 ||
          (payload.azp !== undefined && payload.azp !== audience)) throw authError(401, "Google sign-in could not be verified.");
      const email = payload.email.trim().toLowerCase();
      // email_verified alone is insufficient for first-use email matching on
      // third-party mailboxes. Such accounts need the existing operator sub review.
      const authoritativeEmail = email.endsWith("@gmail.com") ||
        (typeof payload.hd === "string" && !!payload.hd.trim());
      return { sub: payload.sub, email, authoritativeEmail };
    } catch (error) {
      if (error.status) throw error;
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) && !(error instanceof errors.JWKSInvalid)) {
        throw authError(401, "Google sign-in could not be verified.");
      }
      throw authError(503, "Google sign-in is temporarily unavailable.");
    }
  };
}
const verifyGoogle = createGoogleVerifier();
function configured(env) {
  if (!env.GOOGLE_CLIENT_ID?.trim()) throw authError(503, "Google sign-in is not configured. Contact the operator.");
}
async function challenge(request, env) {
  sameOrigin(request, env);
  configured(env);
  const state = random(), nonce = random(), old = readCookie(request, env, "flow");
  const oldSession = readCookie(request, env, "session");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_flows WHERE expires_at<=? OR state_hash=?").bind(instant(), old ? await sha256LowerHex(old) : ""),
    env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(oldSession ? await sha256LowerHex(oldSession) : ""),
    env.DB.prepare("INSERT INTO auth_flows VALUES(?,?,?)").bind(await sha256LowerHex(state), nonce, new Date(Date.now() + 600000).toISOString())
  ]);
  const response = json({ nonce });
  response.headers.append("Set-Cookie", cookie(env, "flow", state, 600));
  response.headers.append("Set-Cookie", cookie(env, "session", "", 0));
  return response;
}
async function claimPreapproval(identity, env) {
  if (!identity.authoritativeEmail) return;
  // One INSERT and its consumption trigger are atomic. Competing first sign-ins
  // can only create one unique mapping; nothing here updates an existing one.
  await env.DB.prepare(`INSERT INTO participant_google_auth(user_id,google_sub,approved_email,enabled,approved_at,approval_note)
      SELECT p.user_id,?,p.approved_email,1,p.approved_at,p.approval_note
      FROM participant_google_preapprovals p JOIN app_users u ON u.id=p.user_id
      WHERE p.approved_email=? AND p.enabled=1 AND p.claimed_at IS NULL AND u.is_active=1
        AND NOT EXISTS(SELECT 1 FROM participant_google_auth a
          WHERE a.user_id=p.user_id OR a.google_sub=? OR a.approved_email=p.approved_email)
      ON CONFLICT DO NOTHING`).bind(identity.sub, identity.email, identity.sub).run();
}
async function login(request, env, verify) {
  sameOrigin(request, env); configured(env);
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) throw authError(415, "Use JSON for sign-in.");
  const text = await request.text();
  if (text.length > 20000) throw authError(400, "Invalid sign-in request.");
  let input;
  try { input = JSON.parse(text); } catch { throw authError(400, "Invalid sign-in request."); }
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["credential", "remember"].includes(key)) ||
      typeof input.credential !== "string" || !input.credential || input.credential.length > 16384 || typeof input.remember !== "boolean") throw authError(400, "Invalid sign-in request.");
  const state = readCookie(request, env, "flow");
  if (!state) throw authError(401, "Sign-in expired. Please try again.");
  const flow = await env.DB.prepare("DELETE FROM auth_flows WHERE state_hash=? RETURNING *").bind(await sha256LowerHex(state)).first();
  if (!flow || flow.expires_at <= instant()) throw authError(401, "Sign-in expired. Please try again.");
  const identity = await verify(input.credential, env.GOOGLE_CLIENT_ID, flow.nonce);
  const findMapping = () => env.DB.prepare(`SELECT a.user_id FROM participant_google_auth a JOIN app_users u ON u.id=a.user_id
    WHERE a.google_sub=? AND a.enabled=1 AND u.is_active=1`).bind(identity.sub).first();
  let mapping = await findMapping();
  if (!mapping) {
    await claimPreapproval(identity, env);
    mapping = await findMapping();
  }
  if (!mapping) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_requests WHERE requested_at<?").bind(new Date(Date.now() - 30 * 86400000).toISOString()),
      env.DB.prepare(`INSERT INTO auth_requests VALUES(?,?,?,?) ON CONFLICT(google_sub)
        DO UPDATE SET verified_email=excluded.verified_email,requested_at=excluded.requested_at`)
        .bind(crypto.randomUUID(), identity.sub, identity.email, instant())
    ]);
    throw authError(403, "This Google account is not approved. Contact the operator.");
  }
  const token = random(), hash = await sha256LowerHex(token);
  const seconds = input.remember ? SESSION_SECONDS : SHORT_SESSION_SECONDS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(instant()),
    env.DB.prepare(`INSERT INTO auth_sessions VALUES(?,
      (SELECT a.user_id FROM participant_google_auth a JOIN app_users u ON u.id=a.user_id
       WHERE a.google_sub=? AND a.enabled=1 AND u.is_active=1),?,?,?)`)
      .bind(hash, identity.sub, identity.sub, instant(), new Date(Date.now() + seconds * 1000).toISOString())
  ]);
  const response = json({ signed_in: true });
  response.headers.append("Set-Cookie", cookie(env, "session", token, input.remember ? seconds : undefined));
  response.headers.append("Set-Cookie", cookie(env, "flow", "", 0));
  return response;
}
export async function authRoute(request, env, verify = verifyGoogle) {
  const path = new URL(request.url).pathname;
  if (path === "/auth/config" && request.method === "GET") return json({ client_id: env.GOOGLE_CLIENT_ID?.trim() || "", configured: Boolean(env.GOOGLE_CLIENT_ID?.trim()) });
  if (path === "/auth/challenge" && request.method === "POST") return challenge(request, env);
  if (path === "/auth/google" && request.method === "POST") return login(request, env, verify);
  if (path === "/auth/session" && request.method === "GET") return json({ current_user: await authenticate(request, env) });
  if (path === "/auth/logout" && request.method === "POST") {
    sameOrigin(request, env);
    const token = readCookie(request, env, "session");
    if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await sha256LowerHex(token)).run();
    const response = json({ signed_out: true });
    response.headers.set("Set-Cookie", cookie(env, "session", "", 0));
    return response;
  }
  return new Response("Not found.", { status: 404 });
}
