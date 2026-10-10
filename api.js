export async function apiRequest(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    referrerPolicy: "no-referrer", headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      // Remove private content immediately, including when another tab logs out.
      document.querySelector("#app")?.replaceChildren();
      location.replace("/");
    }
    throw Object.assign(new Error(data.message || `Request failed (${response.status}).`), { status: response.status });
  }
  return data;
}
