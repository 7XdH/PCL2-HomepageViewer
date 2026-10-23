import proxyHandler from "../../api/proxy.js";

// Netlify Functions hand the handler a web Request and expect a web Response,
// while api/proxy.js is written against the Node (req, res) pair that Vercel and
// server.js provide. This shim collects the Node-style writes and replays them as
// a Response, so every deployment runs exactly the same proxy code path.
// netlify.toml rewrites /api/proxy to /.netlify/functions/proxy, so the viewer
// keeps the single same-origin URL it already uses.

function createNodeResponse() {
  const headers = new Headers();
  let settled = false;
  let body = null;

  const response = {
    statusCode: 200,
    setHeader(name, value) {
      if (value === undefined || value === null) return;
      headers.set(String(name), String(value));
    },
    end(chunk) {
      if (settled) return;
      settled = true;
      if (chunk === undefined || chunk === null) return;
      body = typeof chunk === "string" ? chunk : new Uint8Array(chunk);
    }
  };

  return {
    response,
    toResponse() {
      const status = response.statusCode;
      // 204/304 must not carry a body; every other status here is a plain reply.
      if (status === 204 || status === 304) {
        return new Response(null, { status, headers });
      }
      return new Response(body, { status, headers });
    }
  };
}

export default async function netlifyProxy(request) {
  const { response, toResponse } = createNodeResponse();
  const nodeRequest = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers)
  };
  try {
    await proxyHandler(nodeRequest, response, { platform: "netlify" });
  } catch (error) {
    return new Response(String(error?.message || error), {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  return toResponse();
}
