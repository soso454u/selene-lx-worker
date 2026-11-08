const API = "https://lxmusicapi.onrender.com";
const SOURCES = new Set(["tx", "kw", "kg", "wy", "mg"]);
const QUALITIES = new Set(["128k", "320k"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function reply(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...CORS,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/lx/url") {
      return reply({ code: 404, msg: "Not found" }, 404);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return reply({ code: 405, msg: "Method not allowed" }, 405, {
        Allow: "GET, OPTIONS",
      });
    }

    const source = url.searchParams.get("source") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const quality = url.searchParams.get("quality") ?? "128k";

    if (!SOURCES.has(source) || !QUALITIES.has(quality) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
      return reply({ code: 400, msg: "Invalid parameters" }, 400);
    }

    if (!env.LX_REQUEST_KEY) {
      return reply({ code: 503, msg: "Upstream not configured" }, 503);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      // Reject over-limit clients before they consume the edge's shared quota.
      const perIp = await env.IP_LIMIT.limit({ key: ip });
      if (!perIp.success || !(await env.EDGE_LIMIT.limit({ key: "lx-url" })).success) {
        return reply({ code: 429, msg: "Too many requests" }, 429);
      }
    } catch {
      return reply({ code: 503, msg: "Rate limiter unavailable" }, 503);
    }

    try {
      const response = await fetch(
        [API, "url", source, encodeURIComponent(id), quality].join("/"),
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Request-Key": env.LX_REQUEST_KEY,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
        },
      );

      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502;
        return reply({ code: status, msg: "Upstream HTTP " + response.status }, status);
      }

      const data = await response.json();
      if (data?.code === 5) {
        return reply({ code: 5, msg: "Upstream rate limit exceeded" }, 429);
      }
      if (data?.code !== 0 || typeof data.url !== "string" || !URL.canParse(data.url)) {
        return reply({
          code: data?.code || 502,
          msg: "Upstream did not return a playable URL",
        }, 502);
      }

      const audio = new URL(data.url);
      if (audio.protocol !== "https:" || audio.username || audio.password) {
        return reply({ code: 502, msg: "Invalid audio URL" }, 502);
      }

      return reply({
        code: 0,
        url: audio.href,
        source,
        quality: data.extra?.quality?.result || quality,
        expire: data.extra?.expire ?? null,
      });
    } catch (error) {
      console.error("[Selene LX 调试]", {
        name: error?.name,
        message: String(error?.message || error)
          .replaceAll(env.LX_REQUEST_KEY, "[redacted]")
          .slice(0, 300),
      });
      const msg = error?.name === "TimeoutError"
        ? "Upstream timeout"
        : "Upstream request failed";
      return reply({ code: 502, msg }, 502);
    }
  },
};
