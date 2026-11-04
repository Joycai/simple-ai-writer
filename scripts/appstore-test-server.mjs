// Local acceptance fixture only. Never bundled or started by the application.
import { createServer } from "node:http";
const options = { host: "127.0.0.1", port: "17842", mode: "normal" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, "");
  if (!(key in options) || !argv[i + 1]) throw new Error("Use --host 127.0.0.1|::1 --port N --mode normal|slow|disconnect|redirect");
  options[key] = argv[i + 1];
}
if (!["127.0.0.1", "::1"].includes(options.host)) throw new Error("Loopback binding only");
if (!/^[0-9]+$/.test(options.port) || +options.port > 65535) throw new Error("Invalid port");
if (!["normal", "slow", "disconnect", "redirect"].includes(options.mode)) throw new Error("Invalid mode");
let events = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;
  const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (path === "/__status" && req.method === "GET") { json(200, events); return; }
  if (path === "/__reset" && req.method === "POST") { events = []; json(200, { reset: true }); return; }
  const event = { method: req.method, path, bytes: 0, closed: false, at: new Date().toISOString() };
  events.push(event);
  // Count only; never retain the document, authorization headers or URL query.
  req.on("data", chunk => { event.bytes += chunk.length; if (event.bytes > 16 * 1024 * 1024) req.destroy(); });
  res.on("close", () => { event.closed = true; });
  req.on("end", () => {
    if (path === "/v1/models") { json(200, { object: "list", data: [{ id: "p3-local-model", object: "model", owned_by: "local-fixture" }] }); return; }
    if (path !== "/v1/chat/completions") { json(404, { error: { message: "Local fixture route not implemented" } }); return; }
    if (options.mode === "redirect") { res.writeHead(307, { Location: "/redirect-target" }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.flushHeaders();
    let count = 0;
    const timer = setInterval(() => {
      count++;
      res.write(`data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Local acceptance response. " }, finish_reason: null }] })}\n\n`);
      if (options.mode === "disconnect" && count === 1) { res.destroy(); clearInterval(timer); return; }
      if (options.mode === "normal" && count === 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
        res.end(); clearInterval(timer);
      }
    }, options.mode === "slow" ? 1000 : 100);
    res.on("close", () => clearInterval(timer));
  });
});
server.listen(+options.port, options.host, () => {
  const address = server.address();
  const host = options.host === "::1" ? "[::1]" : options.host;
  process.stdout.write(JSON.stringify({ url: `http://${host}:${address.port}/v1`, mode: options.mode }) + "\n");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
