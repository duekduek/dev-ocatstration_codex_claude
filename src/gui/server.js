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
        case "/api/models": {
          const M = require("../models");
          return send(res, 200, M.modelsFor(q.tool === "claude" ? "claude" : "codex", d, { refresh: q.refresh === "1" }));
        }
        case "/api/run": {
          // 기획 담당 실행/대화: action = start | send | stop | reset (POST), 조회는 GET ?since=
          const R = require("../runner");
          if (req.method === "GET") return send(res, 200, R.view(d, Number(q.since) || 0));
          const cfg = core.loadConfig(d);
          if (!cfg) return send(res, 400, { error: "먼저 설정을 저장하세요" });
          if (q.action === "start") R.start(d, cfg, q.text);
          else if (q.action === "send") { if (!String(q.text || "").trim()) return send(res, 400, { error: "메시지가 비어 있습니다" }); R.send(d, cfg, String(q.text)); }
          else if (q.action === "stop") R.stop(d);
          else if (q.action === "reset") R.reset(d);
          else return send(res, 400, { error: "unknown action" });
          return send(res, 200, R.view(d, Number(q.since) || 0));
        }
        case "/api/usage":
          return send(res, 200, require("../runner").usage(d));
        case "/api/progress":
          return send(res, 200, require("../progress").progress(d));
        case "/api/verify-model": {
          const M = require("../models");
          return send(res, 200, M.verifyModel(d, q.tool, q.model));
        }
        case "/api/docs": {
          // 요구사항 명세 + docs/ 아래 md 파일 목록
          const cfg = core.loadConfig(d);
          const spec = (cfg && cfg.specFile) || core.DEFAULT_CONFIG.specFile;
          const list = [];
          const walk = (rel) => {
            const abs = path.join(d, rel);
            if (!fs.existsSync(abs)) return;
            for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
              const r = path.posix.join(rel, e.name);
              if (e.isDirectory()) walk(r);
              else if (e.name.toLowerCase().endsWith(".md")) list.push({ path: r, mtime: fs.statSync(path.join(d, r)).mtimeMs });
            }
          };
          walk("docs");
          if (!list.some((x) => x.path === spec)) list.push({ path: spec, mtime: 0, missing: !fs.existsSync(path.join(d, spec)) });
          return send(res, 200, { spec, plan: "docs/PLAN.md", files: list });
        }
        case "/api/doc": {
          const rel = String(q.path || "").replace(/\\/g, "/");
          const abs = path.resolve(d, rel);
          // 프로젝트 폴더 안의 .md 파일만 허용
          if (!rel || !abs.startsWith(d + path.sep) || !abs.toLowerCase().endsWith(".md")) return send(res, 400, { error: "허용되지 않는 경로" });
          if (req.method === "POST") {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, String(q.content ?? ""));
            return send(res, 200, { ok: true });
          }
          return send(res, 200, { path: rel, exists: fs.existsSync(abs), content: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "" });
        }
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
