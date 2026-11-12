// 웹에서 기획 담당을 실행/대화하는 실행기
// - Codex: codex exec --json (+ resume <thread_id>)
// - Claude: claude -p --output-format stream-json (+ --resume <session_id>)
// 턴이 끝나면: [완료] → 종료, [질문] → 사용자 답변 대기, 그 외 → 자동으로 "계속 진행"
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MAX_EVENTS = 600;
const runs = new Map(); // dir → state

const devDir = (dir) => { const d = path.join(dir, ".devagent"); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
const trim = (s, n = 4000) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

function state(dir) {
  if (!runs.has(dir)) {
    const sess = readJson(path.join(devDir(dir), "session.json"), {});
    const st = { dir, status: "idle", proc: null, seq: 0, events: [], queue: [], continues: 0, session: sess, lastMessage: "", error: null, startedAt: null, current: null, usage: readJson(path.join(devDir(dir), "usage.json"), {}) };
    // 이전 기록 일부 불러오기
    const log = path.join(devDir(dir), "activity.jsonl");
    if (fs.existsSync(log)) {
      const lines = fs.readFileSync(log, "utf8").trim().split("\n").slice(-200);
      for (const l of lines) { try { const e = JSON.parse(l); e.seq = ++st.seq; st.events.push(e); } catch {} }
    }
    runs.set(dir, st);
  }
  return runs.get(dir);
}

function push(st, ev) {
  ev.ts = ev.ts || Date.now();
  ev.seq = ++st.seq;
  st.events.push(ev);
  if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
  try { const { seq, ...rest } = ev; fs.appendFileSync(path.join(devDir(st.dir), "activity.jsonl"), JSON.stringify(rest) + "\n"); } catch {}
  if (["command", "file", "reading", "subagent"].includes(ev.kind)) st.current = { src: ev.src, kind: ev.kind, text: ev.text, path: ev.path, ts: ev.ts };
}

// 사용량은 계정 단위라 모든 프로젝트가 공유하도록 ~/.devagent/usage.json 에 저장
const GLOBAL_USAGE = path.join(require("os").homedir(), ".devagent", "usage.json");
function saveUsage(st, tool, five, week) {
  st.usage[tool] = { five, week, at: Date.now() };
  try { fs.mkdirSync(path.dirname(GLOBAL_USAGE), { recursive: true }); const g = readJson(GLOBAL_USAGE, {}); g[tool] = st.usage[tool]; fs.writeFileSync(GLOBAL_USAGE, JSON.stringify(g)); } catch {}
}

// ---------- 이벤트 정규화 ----------
function fromCodex(st, src, j) {
  const it = j.item || {};
  if (j.type === "thread.started" && src === "planner") { st.session = { tool: "codex", id: j.thread_id }; saveSession(st); return; }
  if (j.type === "turn.failed" || j.type === "error") return push(st, { src, kind: "error", text: trim(j.error?.message || j.message || JSON.stringify(j)) });
  if (!j.type || !j.type.startsWith("item.")) return;
  const done = j.type === "item.completed";
  switch (it.type) {
    case "agent_message": if (done) { if (src === "planner") st.lastMessage = it.text || ""; push(st, { src, kind: "message", text: trim(it.text) }); } break;
    case "reasoning": if (done && it.text) push(st, { src, kind: "thinking", text: trim(it.text, 600) }); break;
    case "command_execution":
      if (j.type === "item.started") push(st, { src, kind: "command", text: trim(it.command, 400), status: "running" });
      else if (done) push(st, { src, kind: "command-done", text: trim(it.command, 400), status: it.exit_code === 0 ? "ok" : "fail", output: trim(it.aggregated_output, 1500) });
      break;
    case "file_change": if (done) for (const c of it.changes || []) push(st, { src, kind: "file", path: c.path, text: `${c.kind || "update"} ${c.path}` }); break;
    case "todo_list": if (it.items) push(st, { src, kind: "todo", items: it.items.map((x) => ({ text: x.text, done: !!x.completed })) }); break;
    case "web_search": if (done) push(st, { src, kind: "command", text: `웹 검색: ${it.query || ""}` }); break;
    case "error": push(st, { src, kind: "error", text: trim(it.message) }); break;
  }
}
function fromClaude(st, src, j) {
  if (j.type === "system" && j.subtype === "init" && src === "planner") { st.session = { tool: "claude", id: j.session_id }; saveSession(st); return; }
  if (j.type === "rate_limit_event") {
    const w = j.rate_limit_info?.unifiedWindows || {};
    const conv = (x) => x ? { used: Math.round((x.utilization ?? 0) * 100), resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : null;
    return saveUsage(st, "claude", conv(w.five_hour), conv(w.seven_day));
  }
  if (j.type === "assistant") {
    for (const c of j.message?.content || []) {
      if (c.type === "text" && c.text?.trim()) { if (src === "planner" && !j.parent_tool_use_id) st.lastMessage = c.text; push(st, { src, kind: "message", text: trim(c.text), sub: !!j.parent_tool_use_id }); }
      else if (c.type === "thinking" && c.thinking) push(st, { src, kind: "thinking", text: trim(c.thinking, 600) });
      else if (c.type === "tool_use") {
        const i = c.input || {};
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.name)) push(st, { src, kind: "file", path: i.file_path || i.notebook_path, text: `${c.name} ${i.file_path || ""}` });
        else if (c.name === "Read") push(st, { src, kind: "reading", path: i.file_path, text: `읽기 ${i.file_path || ""}` });
        else if (c.name === "Bash") push(st, { src, kind: "command", text: trim(i.command, 400), status: "running" });
        else if (c.name === "Task" || c.name === "Agent") push(st, { src, kind: "subagent", text: `서브 에이전트: ${trim(i.description || i.prompt, 200)}` });
        else if (c.name === "TodoWrite" && Array.isArray(i.todos)) push(st, { src, kind: "todo", items: i.todos.map((t) => ({ text: t.content, done: t.status === "completed" })) });
        else push(st, { src, kind: "command", text: `${c.name} ${trim(JSON.stringify(i), 160)}` });
      }
    }
  }
  if (j.type === "result") { if (j.is_error) push(st, { src, kind: "error", text: trim(j.result) }); if (src === "planner" && j.result) st.lastMessage = j.result; }
}
function feed(st, src, tool, line) {
  line = line.trim();
  if (!line.startsWith("{")) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  (tool === "claude" || j.type === "assistant" || j.type === "system" || j.type === "rate_limit_event" || j.type === "result" ? fromClaude : fromCodex)(st, src, j);
}
function saveSession(st) { try { fs.writeFileSync(path.join(devDir(st.dir), "session.json"), JSON.stringify(st.session)); } catch {} }

// ---------- 개발 담당 로그(.devagent/dev.jsonl) 추적 ----------
const devOffsets = new Map();
function pollDev(st) {
  const f = path.join(devDir(st.dir), "dev.jsonl");
  if (!fs.existsSync(f)) return;
  const size = fs.statSync(f).size;
  let off = devOffsets.get(st.dir);
  if (off === undefined) off = Math.max(0, size - 200 * 1024); // 처음엔 마지막 200KB만
  if (size < off) off = 0;
  if (size === off) return;
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(size - off);
  fs.readSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return;
  devOffsets.set(st.dir, off + Buffer.byteLength(text.slice(0, lastNl + 1)));
  for (const l of text.slice(0, lastNl).split("\n")) feed(st, "developer", null, l);
}

// ---------- 실행 ----------
const CONTINUE_MSG = "계속 진행해. 사용자에게 진행 여부를 묻지 말고 다음 단계로 바로 진행해. 꼭 사용자 결정이 필요할 때만 마지막 줄에 [질문]을 붙여 물어보고, 모든 phase가 끝나면 마지막 줄에 [완료]를 써.";

function buildArgs(cfg, st, prompt, build) {
  const p = cfg.planner;
  const name = `devagent-planner-${slug(cfg.name)}`;
  // 시작할 때는 --build: Dockerfile이 바뀌었으면 이미지를 다시 만든다(안 바뀌었으면 캐시로 바로 진행)
  const base = ["compose", "run", "--rm", "-T", ...(build ? ["--build"] : []), "--name", name, "dev"];
  const resume = st.session && st.session.tool === p.tool && st.session.id;
  if (p.tool === "claude") {
    const a = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    if (p.model) a.push("--model", p.model);
    if (p.reasoning) a.push("--effort", p.reasoning);
    if (resume) a.push("--resume", st.session.id);
    return { args: [...base, ...a], name };
  }
  const a = ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox"];
  if (p.model) a.push("-m", p.model);
  if (p.reasoning) a.push("-c", `model_reasoning_effort="${p.reasoning}"`);
  if (resume) a.push("resume", st.session.id);
  a.push(prompt);
  return { args: [...base, ...a], name };
}

function runTurn(dir, cfg, prompt, { user, build } = {}) {
  const st = state(dir);
  if (st.proc) throw new Error("이미 실행 중입니다");
  if (user) push(st, { src: "user", kind: "message", text: trim(prompt) });
  const { args, name } = buildArgs(cfg, st, prompt, build);
  if (build) push(st, { src: "system", kind: "system", text: "컨테이너 준비 중 (Dockerfile이 바뀌었으면 이미지를 다시 빌드합니다)" });
  require("./core").ensureVolumes();
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" }); // 이전에 남은 컨테이너 정리
  st.status = "running"; st.error = null; st.startedAt = Date.now(); st.lastMessage = ""; st.containerName = name;
  // stdin을 닫아야 함: codex exec는 stdin이 파이프면 끝날 때까지 기다렸다가 프롬프트에 덧붙인다
  const proc = spawn("docker", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  st.proc = proc;
  let buf = "", errBuf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { feed(st, "planner", cfg.planner.tool, buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  proc.stderr.on("data", (d) => { errBuf = (errBuf + d.toString("utf8")).slice(-4000); });
  proc.on("close", (code) => {
    if (buf) feed(st, "planner", cfg.planner.tool, buf);
    st.proc = null;
    refreshUsage(dir, { probe: false }); // 턴이 끝날 때마다 사용량 기록 다시 읽기
    if (st.stopping) { st.stopping = false; st.status = "idle"; push(st, { src: "system", kind: "system", text: "중지됨" }); return; }
    const msg = st.lastMessage || "";
    if (code !== 0 && !msg) {
      const err = errBuf.split("\n").filter((l) => l && !/level=warning|Container /.test(l)).slice(-3).join(" ");
      st.status = "error"; st.error = err || `종료 코드 ${code}`;
      push(st, { src: "system", kind: "error", text: `기획 담당 실행 실패: ${st.error}` });
      return;
    }
    if (/\[완료\]/.test(msg)) { st.status = "done"; st.continues = 0; push(st, { src: "system", kind: "system", text: "모든 작업 완료" }); return; }
    if (st.queue.length) { const next = st.queue.shift(); return setImmediate(() => safeTurn(dir, cfg, next, true)); }
    if (/\[질문\]/.test(msg)) { st.status = "waiting"; push(st, { src: "system", kind: "system", text: "기획 담당이 답변을 기다립니다" }); return; }
    if (cfg.autoContinue !== false && st.continues < (cfg.maxAutoContinue || 40)) {
      st.continues++;
      push(st, { src: "system", kind: "system", text: `자동 계속 진행 (${st.continues})` });
      return setTimeout(() => safeTurn(dir, cfg, CONTINUE_MSG, false), 1500);
    }
    st.status = "idle";
  });
  return st;
}
function safeTurn(dir, cfg, prompt, user) {
  try { runTurn(dir, cfg, prompt, { user }); }
  catch (e) { const st = state(dir); st.status = "error"; st.error = e.message; push(st, { src: "system", kind: "error", text: e.message }); }
}

// 시작/이어하기
function start(dir, cfg, prompt) {
  const st = state(dir);
  st.continues = 0;
  const p = prompt || (st.session?.id ? "이어서 진행해. docs/PLAN.md와 docs/progress.json을 확인하고 남은 phase를 계속 진행해." : null);
  return runTurn(dir, cfg, p || require("./core").DEFAULT_PROMPT(cfg), { user: !!prompt, build: true });
}
// 사용자 메시지: 실행 중이면 이번 턴이 끝난 뒤 전달
function send(dir, cfg, text) {
  const st = state(dir);
  st.continues = 0;
  if (st.proc) { st.queue.push(text); push(st, { src: "user", kind: "message", text: trim(text), queued: true }); return st; }
  return runTurn(dir, cfg, text, { user: true });
}
function stop(dir) {
  const st = state(dir);
  st.queue = [];
  if (st.proc) { st.stopping = true; spawnSync("docker", ["stop", "-t", "3", st.containerName], { encoding: "utf8" }); try { st.proc.kill(); } catch {} }
  else st.status = "idle";
  return st;
}
function reset(dir) {
  const st = state(dir);
  if (st.proc) throw new Error("실행 중에는 새 대화를 시작할 수 없습니다");
  st.session = {}; saveSession(st); st.status = "idle"; st.continues = 0;
  push(st, { src: "system", kind: "system", text: "새 대화로 시작합니다 (진행 기록 파일은 유지)" });
  return st;
}

// ---------- 사용량 ----------

// Codex 사용량: 세션 기록(rollout-*.jsonl)의 token_count.rate_limits(limit_id "codex") 중 가장 최신 값
// + 그 뒤에 "usage_limit_exceeded" 오류가 있으면 소진으로 표시. 컨테이너와 PC 기록을 모두 본다(같은 계정).
const LIMIT_RE = /"rate_limits"|usage_limit_exceeded/;
function scanCodexLines(lines, acc) {
  for (const l of lines) {
    if (!LIMIT_RE.test(l)) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(j.timestamp) || 0, p = j.payload || {};
    const rl = p.rate_limits || p.info?.rate_limits;
    if (p.type === "token_count" && rl && rl.limit_id === "codex" && rl.primary) {
      if (ts > acc.ts) Object.assign(acc, { ts, primary: rl.primary, secondary: rl.secondary });
    }
    const err = p.error || (p.type === "error" ? p : null);
    if (err && /usage_limit_exceeded|usage limit/i.test(JSON.stringify(err)) && ts > acc.limitTs) {
      acc.limitTs = ts; acc.limitMsg = String(err.message || "").slice(0, 200);
    }
  }
}
function hostRolloutFiles(n = 6) {
  const root = path.join(require("os").homedir(), ".codex", "sessions");
  const out = [];
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    // 날짜 폴더(YYYY/MM/DD)는 최신 것부터 2개씩만
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, depth < 2 ? 2 : 3);
    for (const e of ents) if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) { const f = path.join(d, e.name); out.push({ f, m: fs.statSync(f).mtimeMs }); }
    for (const x of dirs) walk(path.join(d, x), depth + 1);
  })(root, 0);
  return out.sort((a, b) => b.m - a.m).slice(0, n).map((x) => x.f);
}
// ---------- 사용량 (비동기 갱신: 화면이 멈추지 않도록 백그라운드에서 측정) ----------
const runAsync = (args, cwd, timeout = 120000) => new Promise((resolve) => {
  let out = "", done = false;
  const p = spawn("docker", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
  p.stdout.on("data", (d) => { if (out.length < 32 * 1024 * 1024) out += d; });
  p.on("close", (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } });
  p.on("error", () => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out }); } });
});
const hasCompose = (dir) => fs.existsSync(path.join(dir, "docker-compose.yml"));

// Codex: 세션 기록 스캔 결과를 계정 단위로 저장
function codexFromAcc(acc) {
  if (!acc.ts && !acc.limitTs) return null;
  const conv = (x) => x ? { used: Math.round(x.used_percent), resetsAt: x.resets_at ? x.resets_at * 1000 : null } : null;
  const data = { five: conv(acc.primary), week: conv(acc.secondary), at: Math.max(acc.ts, acc.limitTs) };
  if (acc.limitTs > acc.ts) {
    data.exhausted = true; data.message = acc.limitMsg;
    const w = data.week && data.week.used >= 95 ? "week" : "five";
    if (data[w] && (!data[w].resetsAt || data[w].resetsAt > Date.now())) data[w].used = 100;
    else if (!data[w]) data[w] = { used: 100, resetsAt: null };
  }
  return data;
}
async function scanCodex(dir) {
  const acc = { ts: 0, limitTs: 0 };
  if (hasCompose(dir)) {
    require("./core").ensureVolumes();
    const r = await runAsync(["compose", "run", "--rm", "-T", "dev", "bash", "-lc",
      'fs=$(ls -t $(find ~/.codex/sessions -name "rollout-*.jsonl" 2>/dev/null) 2>/dev/null | head -6); [ -n "$fs" ] && grep -h -E "\\"rate_limits\\"|usage_limit_exceeded" $fs'], dir, 60000);
    scanCodexLines(r.out.split("\n"), acc);
  }
  for (const f of hostRolloutFiles()) { try { scanCodexLines(fs.readFileSync(f, "utf8").split("\n"), acc); } catch {} }
  const data = codexFromAcc(acc);
  if (data) { const g = readJson(GLOBAL_USAGE, {}); if (!g.codex || data.at >= (g.codex.at || 0)) { g.codex = data; writeGlobal(g); } }
}
// Codex 현재 값: 아주 짧은 요청을 보내면 세션 기록에 최신 rate_limits가 남는다
async function probeCodex(dir) {
  if (!hasCompose(dir)) return;
  require("./core").ensureVolumes();
  await runAsync(["compose", "run", "--rm", "-T", "dev", "bash", "-lc", 'cd /tmp && codex exec --json --skip-git-repo-check -s read-only "Reply with a single dot." >/dev/null 2>&1; true'], dir, 120000);
}
// Claude 현재 값: haiku로 아주 짧은 요청 → rate_limit_event
async function probeClaude(dir) {
  if (!hasCompose(dir)) return;
  require("./core").ensureVolumes();
  const r = await runAsync(["compose", "run", "--rm", "-T", "dev", "claude", "-p", ".", "--model", "haiku", "--max-turns", "1", "--output-format", "stream-json", "--verbose"], dir, 90000);
  const st = state(dir);
  for (const l of r.out.split("\n")) if (l.includes('"rate_limit_event"')) feed(st, "probe", "claude", l);
}
function writeGlobal(g) { try { fs.mkdirSync(path.dirname(GLOBAL_USAGE), { recursive: true }); fs.writeFileSync(GLOBAL_USAGE, JSON.stringify(g)); } catch {} }

// 갱신 요청: 같은 작업이 겹치지 않게, 너무 자주 하지 않게
const refreshing = { codex: false, claude: false };
const lastRefresh = { codex: 0, claude: 0, scan: 0 };
function refreshUsage(dir, { probe = true } = {}) {
  const g = readJson(GLOBAL_USAGE, {});
  const now = Date.now();
  if (!refreshing.codex) {
    // 실제 측정(probe)은 1분 간격, 기록 스캔만은 언제든
    const doProbe = probe && now - lastRefresh.codex > 60000;
    refreshing.codex = true;
    (async () => { try { if (doProbe) { lastRefresh.codex = now; await probeCodex(dir); } await scanCodex(dir); } finally { refreshing.codex = false; } })();
  }
  if (!refreshing.claude && probe && now - lastRefresh.claude > 60000) {
    refreshing.claude = true; lastRefresh.claude = now;
    (async () => { try { await probeClaude(dir); } finally { refreshing.claude = false; } })();
  }
}

// 조회: 저장된 값을 바로 돌려주고, force거나 10분 넘게 오래됐으면 백그라운드 갱신 시작
function usage(dir, force) {
  const st = state(dir);
  pollDev(st);
  const g = readJson(GLOBAL_USAGE, {});
  const stale = (x) => !x || Date.now() - x.at > 10 * 60000;
  if (force || stale(g.codex) || stale(g.claude)) refreshUsage(dir, { probe: true });
  const fix = (x) => {
    if (!x) return null;
    const c = { ...x };
    for (const k of ["five", "week"]) if (c[k] && c[k].resetsAt && c[k].resetsAt < Date.now()) c[k] = { ...c[k], used: 0, stale: true };
    return c;
  };
  const cl = [st.usage.claude, g.claude].filter(Boolean).sort((a, b) => b.at - a.at)[0];
  return { codex: fix(g.codex), claude: fix(cl), refreshing: refreshing.codex || refreshing.claude };
}


// ---------- 조회 ----------
function view(dir, since = 0) {
  const st = state(dir);
  pollDev(st);
  return {
    status: st.status, error: st.error, session: st.session, startedAt: st.startedAt, queue: st.queue.length, continues: st.continues,
    current: st.current, seq: st.seq,
    events: st.events.filter((e) => e.seq > since).slice(-300),
  };
}

module.exports = { start, send, stop, reset, view, usage };
