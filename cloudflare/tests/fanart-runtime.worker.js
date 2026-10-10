// Synthetic fixture: run fanart code inside workerd, without external requests or real bindings.
import { banners, bannerPreview } from "../src/fanart.js";

export default { async fetch() {
  const requests = [];
  const objects = new Map();
  let cache;
  const env = {
    FANART_TV: "synthetic-runtime-key",
    DB: { prepare(sql) { return { bind(...values) { return {
      async first() { return cache; },
      async run() { cache = { banners: values[1], expires_at: values[2], failure: 0 }; }
    }; } }; } },
    ARTWORK: {
      async head(key) { return objects.get(key); },
      async put(key, body, options) { objects.set(key, { body, ...options }); },
      async get(key) { return objects.get(key); }
    }
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    // Native workerd Request construction catches redirect-mode regressions before mocking I/O.
    const request = new Request(url, options);
    requests.push({ redirect: request.redirect, provider: new URL(url).hostname === "webservice.fanart.tv", credential: request.headers.has("api-key") });
    return new URL(url).hostname === "webservice.fanart.tv"
      ? Response.json({ thetvdb_id: "123", tvbanner: [{ id: "2", width: "1000", height: "185", url: "https://assets.fanart.tv/fanart/tv/123/tvbanner/synthetic.png" }] })
      : new Response(new Uint8Array([1,2,3]), { headers: { "content-type": "image/png" } });
  };
  try {
    const result = await banners("123",env);
    const preview = await bannerPreview(new URL("https://fixture.test/artwork/fanart/123/2"),env);
    return Response.json({ count: result.length, bytes: [...new Uint8Array(await preview.arrayBuffer())], requests });
  } finally { globalThis.fetch = original; }
} };
