const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const CAMERA_URL = process.env.CAMERA_URL || "https://plain-eyes-sell.loca.lt/camera-proxy";

function pickClient(url) {
  return url.protocol === "https:" ? https : http;
}

function proxyCamera(req, res) {
  let source;
  try {
    source = new URL(CAMERA_URL);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Invalid CAMERA_URL");
    return;
  }

  const client = pickClient(source);
  const upstreamReq = client.request(
    {
      protocol: source.protocol,
      hostname: source.hostname,
      port: source.port || (source.protocol === "https:" ? 443 : 80),
      path: `${source.pathname}${source.search}`,
      method: "GET",
      headers: {
        host: source.host,
        "user-agent": "smart-shed-camera-proxy",
        accept: "*/*",
      },
      timeout: 12000,
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"] || "application/octet-stream";
      res.writeHead(upstreamRes.statusCode || 502, {
        "content-type": contentType,
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        pragma: "no-cache",
        expires: "0",
        "access-control-allow-origin": "*",
      });
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("Camera timeout"));
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`Camera proxy error: ${err.message}`);
  });

  upstreamReq.end();
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cameraUrl: CAMERA_URL }));
    return;
  }

  if (req.url === "/camera-proxy") {
    proxyCamera(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Camera proxy running on http://localhost:${PORT}/camera-proxy`);
  console.log(`Upstream camera source: ${CAMERA_URL}`);
});
