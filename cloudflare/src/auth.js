export async function sha256LowerHex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
