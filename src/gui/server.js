// devagent GUI: 로컬 전용 웹 서버 (127.0.0.1)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("../core");

function serve({ dir, port }) {
  const token = crypto.randomBytes(16).toString("hex");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
    .replace("__TOKEN__", token)
    .replace("__DIR__", JSON.stringify(dir).slice(1, -1));

  const send = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((ok, fail) => {
    let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      // 이 페이지에서 온 요청만 허용
      if (req.headers["x-devagent-token"] !== token) return send(res, 403, { error: "forbidden" });
      const q = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
      const d = path.resolve(q.dir || dir);

      switch (url.pathname) {
        case "/api/meta":
          return send(res, 200, {
            platforms: Object.fromEntries(Object.entries(core.PLATFORMS).map(([k, p]) => [k, p.label])),
            hints: core.MODEL_HINTS, defaults: core.DEFAULT_CONFIG,
          });
        case "/api/project": {
          const cfg = core.loadConfig(d);
          const s = core.status(d);
          return send(res, 200, { dir: d, exists: fs.existsSync(d), config: cfg, docker: s.docker, remote: s.remote, lastCommit: s.lastCommit, login: s.login });
        }
        case "/api/save": {
          const logs = [];
          const cfg = core.init(d, q.config, (m) => logs.push(m));
          return send(res, 200, { config: cfg, log: logs });
        }
        case "/api/terminal": {
          const allowed = { login: ["login"], repo: ["repo"], start: ["start"], shell: ["shell"], status: ["status"] };
          if (!allowed[q.action]) return send(res, 400, { error: "unknown action" });
          if (!core.loadConfig(d)) return send(res, 400, { error: "먼저 설정을 저장하세요" });
          core.openTerminal(d, [...allowed[q.action], "--dir", d]);
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const u = `http://127.0.0.1:${port}`;
    console.log(`devagent GUI: ${u}  (종료: Ctrl+C)`);
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", u]] : process.platform === "darwin" ? ["open", [u]] : ["xdg-open", [u]];
    if (!process.env.DEVAGENT_NO_OPEN) require("child_process").spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
  });
  return server;
}

module.exports = { serve };
