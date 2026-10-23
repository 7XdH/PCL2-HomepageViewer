import proxyHandler from "../../api/proxy.js";

// Netlify can invoke a function through either of its two APIs:
//   * Functions 2.0 — a web Request goes in and a web Response comes out.
//   * Functions 1.0 — a Lambda-style event goes in and an {statusCode, headers,
//     body} object comes out.
// api/proxy.js is written against the Node (req, res) pair that Vercel and
// server.js provide, so this module adapts both directions and then hands over
// to the very same handler. netlify.toml rewrites /api/proxy to
// /.netlify/functions/proxy, so the viewer keeps the one same-origin URL it
// already uses on every deployment.

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

async function handleWebRequest(request) {
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

// Functions 1.0 event → web Request. rawUrl carries the query string verbatim,
// which is what the proxy needs to read ?url=; older payloads only expose
// multiValueQueryStringParameters.
function eventToRequest(event) {
  const host = event.headers?.host || event.headers?.Host || "localhost";
  const path = event.rawPath || event.path || "/api/proxy";
  let query = event.rawQuery || "";
  if (!query && event.multiValueQueryStringParameters) {
    query = new URLSearchParams(
      Object.entries(event.multiValueQueryStringParameters).flatMap(([key, values]) =>
        (values || []).map((value) => [key, value])
      )
    ).toString();
  }
  const url = event.rawUrl || `https://${host}${path}${query ? `?${query}` : ""}`;
  return new Request(url, { method: event.httpMethod || "GET", headers: event.headers || {} });
}

async function responseToLambda(response) {
  const headers = {};
  for (const [name, value] of response.headers) headers[name] = value;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  const textual = /^(?:text\/|application\/(?:json|xml|xaml))/.test(contentType);
  return {
    statusCode: response.status,
    headers,
    body: textual ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !textual
  };
}

export default async function netlifyProxy(input) {
  if (input instanceof Request) return handleWebRequest(input);
  const request = eventToRequest(input || {});
  return responseToLambda(await handleWebRequest(request));
}
