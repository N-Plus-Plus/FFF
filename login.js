// Mirrors CanBan SignIn.tsx: official GIS outline_dark, responsive width,
// explicit account selection, retry and no automatic sign-in.
const host = document.querySelector("#googleButton");
const notice = document.querySelector("#loginMessage");
const retry = document.querySelector("#retryGoogle");
const status = document.querySelector("#signInStatus");
let observer, scriptReady, busy = false;
if (location.search) history.replaceState(null, "", "/");
async function auth(path, body) {
  const response = await fetch(`/auth/${path}`, { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Sign-in failed. Please try again.");
  return data;
}
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!scriptReady) scriptReady = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client"; script.async = true;
    const failed = () => { clearTimeout(timeout); script.remove(); scriptReady = undefined; reject(new Error("Google sign-in could not load. Check your connection and retry.")); };
    const timeout = setTimeout(failed, 15000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = failed; document.head.append(script);
  });
  return scriptReady;
}
function failure(error) {
  notice.textContent = error.message || "Sign-in failed. Please try again.";
  notice.hidden = false; retry.hidden = false;
}
async function initialize(clearError = true) {
  observer?.disconnect(); host.replaceChildren(); retry.hidden = true;
  if (clearError) notice.hidden = true;
  const config = await auth("config");
  if (!config.configured) throw new Error("Google sign-in is not configured. Contact the operator.");
  const { nonce } = await auth("challenge", {});
  await loadGoogle();
  const google = window.google?.accounts?.id;
  if (!google) throw new Error("Google sign-in could not load. Please retry.");
  google.initialize({ client_id: config.client_id, nonce, auto_select: false, ux_mode: "popup", callback: async ({ credential }) => {
    if (busy) return;
    busy = true; host.inert = true; host.setAttribute("aria-busy", "true"); status.hidden = false;
    try {
      await auth("google", { credential, remember: document.querySelector("#rememberMe").checked });
      new BroadcastChannel("ww-session").postMessage("changed");
      google.disableAutoSelect(); location.replace("/");
    } catch (error) {
      failure(error);
      // The challenge is consumed, including on rejection. Obtain a fresh nonce.
      await initialize(false).catch(failure);
    } finally { busy = false; host.inert = false; host.setAttribute("aria-busy", "false"); status.hidden = true; }
  } });
  let width = 0;
  const render = () => {
    const next = Math.floor(Math.min(320, host.clientWidth));
    if (next < 1 || next === width) return;
    width = next; host.replaceChildren();
    google.renderButton(host, { theme: "outline_dark", size: "large", type: "standard", shape: "rectangular", width: next });
  };
  render(); observer = new ResizeObserver(render); observer.observe(host);
}
retry.addEventListener("click", () => initialize().catch(failure));
initialize().catch(failure);
