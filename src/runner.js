// 웹에서 기획 담당을 실행/대화하는 실행기
// - Codex: codex exec --json (+ resume <thread_id>)
// - Claude: claude -p --output-format stream-json (+ --resume <session_id>)
// 턴이 끝나면: [완료] → 종료, [질문] → 사용자 답변 대기, 그 외 → 자동으로 "계속 진행"
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const fallback = require("./fallback");
const { devCmd } = require("./templates");

const MAX_EVENTS = 600;
const runs = new Map(); // dir → state

const devDir = (dir) => { const d = path.join(dir, ".devagent"); fs.mkdirSync(d, { recursive: true }); return d; };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
const trim = (s, n = 4000) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

const keyOf = (dir) => { const r = path.resolve(dir); return process.platform === "win32" ? r.toLowerCase() : r; };
function state(dir) {
  const key = keyOf(dir);
  if (!runs.has(key)) {
    const sess = readJson(path.join(devDir(dir), "session.json"), {});
    const st = { dir, status: "idle", proc: null, seq: 0, events: [], queue: [], continues: 0, session: sess, lastMessage: "", error: null, startedAt: null, current: null, usage: readJson(path.join(devDir(dir), "usage.json"), {}) };
    // 이전 기록 일부 불러오기
    const log = path.join(devDir(dir), "activity.jsonl");
    if (fs.existsSync(log)) {
      const lines = fs.readFileSync(log, "utf8").trim().split("\n").slice(-200);
      for (const l of lines) { try { const e = JSON.parse(l); e.seq = ++st.seq; st.events.push(e); } catch {} }
    }
    runs.set(key, st);
  }
  return runs.get(key);
}

// ---------- 소요시간·토큰 집계 (.devagent/stats.json) ----------
const ROLE_KO = { planner: "기획", developer: "개발" };
const blankTot = () => ({ ms: 0, in: 0, out: 0, cached: 0, n: 0 });
function loadStats(st) {
  if (!st.stats) { const s = readJson(path.join(devDir(st.dir), "stats.json"), {}); st.stats = { planner: { ...blankTot(), ...s.planner }, developer: { ...blankTot(), ...s.developer }, since: s.since || Date.now() }; }
  return st.stats;
}
const saveStats = (st) => { try { fs.writeFileSync(path.join(devDir(st.dir), "stats.json"), JSON.stringify(st.stats)); } catch {} };
// 토큰 사용 보고: Claude result.usage / Codex turn.completed.usage
function addTokens(cur, u, tool) {
  if (!cur || !u) return;
  if (tool === "codex") { const c = u.cached_input_tokens || 0; cur.in += Math.max(0, (u.input_tokens || 0) - c); cur.cached += c; }
  else { cur.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); cur.cached += u.cache_read_input_tokens || 0; }
  cur.out += u.output_tokens || 0; cur.counted = true;
}
const sessStart = (tool) => ({ t0: Date.now(), tool, in: 0, out: 0, cached: 0 });
function sessEnd(st, src, cur, ms, note) {
  if (!cur) return;
  ms = ms || Date.now() - cur.t0;
  const tot = loadStats(st)[src];
  tot.ms += ms; tot.in += cur.in; tot.out += cur.out; tot.cached += cur.cached; tot.n++;
  saveStats(st);
  push(st, { src, kind: "session", tool: cur.tool, ms, in: cur.in, out: cur.out, cached: cur.cached, counted: !!cur.counted, note, text: `${ROLE_KO[src]} 세션 종료` });
}
// 개발 담당 세션 추적 (dev.jsonl): 시작/끝
function devTrack(st, j) {
  if (st.replaying) return;
  st.devLast = Date.now();
  const startEv = (j.type === "system" && j.subtype === "init") || j.type === "turn.started";
  const endEv = j.type === "result" || j.type === "turn.completed" || j.type === "turn.failed";
  const tool = j.type === "system" || j.type === "result" ? "claude" : "codex";
  if (startEv && !st.devCur) st.devCur = sessStart(tool);
  if (startEv) st.devBusy = true;
  if (endEv) {
    if (!st.devCur) st.devCur = sessStart(tool);
    addTokens(st.devCur, j.usage, tool);
    sessEnd(st, "developer", st.devCur, j.duration_ms, j.type === "turn.failed" || j.is_error ? "오류" : null);
    st.devCur = null; st.devBusy = false;
  }
}

// ---------- 사용자 질의 / 답변 (.devagent/qa.json) ----------
const QA_NOTE = "\n\n(이 메시지에 대한 답이나 반영 결과는 먼저 `[답변]`으로 시작하는 메시지 하나로 사용자에게 짧게 써라. 그 다음에 하던 작업을 이어가.)";
const qaFile = (st) => path.join(devDir(st.dir), "qa.json");
// 파일을 밖에서 고친 경우(지난 기록 옮기기 등)도 반영되도록 수정 시각이 바뀌면 다시 읽는다
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
function loadQa(st) {
  const m = mtimeOf(qaFile(st));
  if (!st.qa || m !== st.qaMtime) { st.qa = readJson(qaFile(st), []); st.qaMtime = m; }
  return st.qa;
}
const saveQa = (st) => { try { fs.writeFileSync(qaFile(st), JSON.stringify(st.qa.slice(-200))); st.qaMtime = mtimeOf(qaFile(st)); } catch {} };
function qaAdd(st, text, queued) {
  const e = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 6), q: text, ts: Date.now(), status: queued ? "queued" : "asked" };
  loadQa(st).push(e); if (!queued) st.qaActive = e.id; saveQa(st); return e;
}
// 대기열에 있던 질의를 이번 턴으로 전달
function qaDeliver(st) {
  const e = loadQa(st).find((x) => x.status === "queued");
  if (e) { e.status = "asked"; e.askedAt = Date.now(); st.qaActive = e.id; saveQa(st); }
}
function qaAnswer(st, text, how) {
  const e = st.qaActive && loadQa(st).find((x) => x.id === st.qaActive);
  st.qaActive = null;
  if (!e) return;
  e.status = "answered"; e.answer = String(text || "").trim() || "(답변 없음)"; e.answeredAt = Date.now(); if (how) e.how = how;
  saveQa(st);
  push(st, { src: "system", kind: "qa-answer", id: e.id, text: "질의에 대한 답변이 도착했습니다 (질의 탭)" });
}

function push(st, ev) {
  // 질의에 대한 [답변] 메시지는 진행 피드가 아니라 질의 탭으로 보낸다
  if (st.qaActive && ev.src === "planner" && ev.kind === "message" && !ev.sub && /\[답변\]/.test(ev.text || "")) {
    return qaAnswer(st, ev.text.slice(ev.text.indexOf("[답변]") + 4));
  }
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
  if (j.type === "thread.started" && src === "planner") { setSession(st, "codex", j.thread_id); return; }
  if (j.type === "turn.failed" || j.type === "error") {
    const text = j.error?.message || j.message || JSON.stringify(j);
    limitCheck(st, src, "codex", text);
    return push(st, { src, kind: "error", text: trim(text) });
  }
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
    case "error": limitCheck(st, src, "codex", it.message); push(st, { src, kind: "error", text: trim(it.message) }); break;
  }
}
function fromClaude(st, src, j) {
  if (j.type === "system" && j.subtype === "init" && src === "planner") { setSession(st, "claude", j.session_id); return; }
  if (j.type === "rate_limit_event") {
    const info = j.rate_limit_info || {}, w = info.unifiedWindows || {};
    const conv = (x) => x ? { used: Math.round((x.utilization ?? 0) * 100), resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : null;
    if (info.status === "rejected") limitCheck(st, src, "claude", "rate limit rejected", info.resetsAt ? info.resetsAt * 1000 : null);
    else if (info.status && src !== "probe" && !st.replaying && fallback.exhaustedUntil("claude")) fallback.clear("claude"); // 실제 요청이 통과 → 한도 풀림
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
  if (j.type === "result") { if (j.is_error) { limitCheck(st, src, "claude", j.result); push(st, { src, kind: "error", text: trim(j.result) }); } if (src === "planner" && j.result) st.lastMessage = j.result; }
}
// 한도 소진 메시지면 그 도구를 소진으로 기록하고, 기획 담당 쪽이면 이번 턴이 한도로 끝났다고 표시
function limitCheck(st, src, tool, text, until) {
  if (st.replaying || (!until && !fallback.isLimitText(text))) return;
  if (!until) until = tool === "codex"
    ? parseRetry(text, Date.now(), true) // 컨테이너는 UTC 시간대로 메시지를 쓴다
    : (readJson(GLOBAL_USAGE, {}).claude?.five?.resetsAt || st.usage.claude?.five?.resetsAt);
  const known = fallback.exhaustedUntil(tool);
  const x = fallback.markExhausted(tool, until, text);
  if (src === "planner") st.limitHit = tool;
  if (!known) push(st, { src: "system", kind: "system", text: `${tool === "claude" ? "Claude" : "Codex"} 사용량 한도 소진 (${src === "developer" ? "개발" : src === "planner" ? "기획" : "측정"} 중) · ${fallback.hhmm(x.until)}에 초기화 예상` });
}
function feed(st, src, tool, line) {
  line = line.trim();
  if (!line.startsWith("{")) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  if (src === "developer") devTrack(st, j);
  else if (src === "planner") {
    if (j.type === "result") addTokens(st.planCur, j.usage, "claude");
    else if (j.type === "turn.completed") addTokens(st.planCur, j.usage, "codex");
    // 기획 담당이 개발 명령을 실행하기 시작 → 개발 담당 작업 중으로 본다 (dev.jsonl 첫 줄이 나오기 전 틈)
    if (/dev\.jsonl/.test(line) && /"(command_execution|tool_use)"/.test(line) && /item\.started|"assistant"/.test(line)) { st.devBusy = true; st.devLast = Date.now(); }
  }
  (tool === "claude" || j.type === "assistant" || j.type === "system" || j.type === "rate_limit_event" || j.type === "result" ? fromClaude : fromCodex)(st, src, j);
}
function saveSession(st) { try { fs.writeFileSync(path.join(devDir(st.dir), "session.json"), JSON.stringify(st.session)); } catch {} }
// 도구별 세션을 따로 기억해 둔다: 한도로 도구를 바꿨다가 돌아오면 원래 대화를 이어간다
function setSession(st, tool, id) {
  const byTool = { ...(st.session?.byTool || {}) };
  if (st.session?.tool && st.session.id && !byTool[st.session.tool]) byTool[st.session.tool] = st.session.id;
  byTool[tool] = id;
  st.session = { tool, id, byTool };
  saveSession(st);
}
const sessionFor = (st, tool) => st.session?.byTool?.[tool] || (st.session?.tool === tool && st.session.id) || null;

// ---------- 개발 담당 로그(.devagent/dev.jsonl) 추적 ----------
const devOffsets = new Map();
function pollDev(st) {
  const f = path.join(devDir(st.dir), "dev.jsonl");
  if (!fs.existsSync(f)) return;
  const size = fs.statSync(f).size;
  let off = devOffsets.get(st.dir);
  const first = off === undefined;
  if (first) off =Math.max(0, size - 200 * 1024); // 처음엔 마지막 200KB만
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
  st.replaying = first; // 처음 읽는 지난 기록의 한도 메시지는 이미 지난 일이라 무시
  try { for (const l of text.slice(0, lastNl).split("\n")) feed(st, "developer", null, l); } finally { st.replaying = false; }
  maybeInterrupt(st);
}

// 실행 중에 사용자 메시지가 들어오면: 개발 담당이 일하는 중이 아닐 때 기획 턴을 멈추고 바로 전달한다
// (기획 턴 하나가 개발 지시를 여러 번 포함해 한 시간 넘게 이어질 수 있어서 턴 끝까지 기다리면 너무 늦다)
const DEV_STALE = 15 * 60000;
function maybeInterrupt(st) {
  if (!st.proc || !st.queue.length || st.interrupting || st.stopping) return;
  if (st.cfg && st.cfg.interruptOnMessage === false) return;
  if (st.devBusy && Date.now() - (st.devLast || 0) < DEV_STALE) return;
  st.interrupting = true;
  push(st, { src: "system", kind: "system", text: "새 메시지를 바로 전달하려고 진행 중인 기획 턴을 잠시 멈춥니다 (답변 뒤 이어서 진행)" });
  spawnSync("docker", ["stop", "-t", "5", st.containerName], { encoding: "utf8" });
  try { st.proc.kill(); } catch {}
}
const INTERRUPT_NOTE = "[사용자 메시지] 진행 중이던 네 턴을 사용자 메시지 전달을 위해 중간에 끊었다. 먼저 아래 메시지에 답하거나 반영하고, 끊긴 작업은 git status와 docs/progress.json을 확인해 이어서 진행해.\n\n";

// ---------- 실행 ----------
const CONTINUE_MSG = "계속 진행해. 사용자에게 진행 여부를 묻지 말고 다음 단계로 바로 진행해. 꼭 사용자 결정이 필요할 때만 마지막 줄에 [질문]을 붙여 물어보고, 모든 phase가 끝나면 마지막 줄에 [완료]를 써.";

function buildArgs(cfg, st, prompt, build) {
  const p = cfg.planner;
  const name = `devagent-planner-${slug(cfg.name)}`;
  // 시작할 때는 --build: Dockerfile이 바뀌었으면 이미지를 다시 만든다(안 바뀌었으면 캐시로 바로 진행)
  const base = ["compose", "run", "--rm", "-T", ...(build ? ["--build"] : []), "--name", name, "dev"];
  const resume = sessionFor(st, p.tool);
  if (p.tool === "claude") {
    const a = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    if (p.model) a.push("--model", p.model);
    if (p.reasoning) a.push("--effort", p.reasoning);
    if (resume) a.push("--resume", resume);
    return { args: [...base, ...a], name };
  }
  const a = ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox"];
  if (p.model) a.push("-m", p.model);
  if (p.reasoning) a.push("-c", `model_reasoning_effort="${p.reasoning}"`);
  if (resume) a.push("resume", resume);
  a.push(prompt);
  return { args: [...base, ...a], name };
}

// 역할 도구가 한도 때문에 바뀌었거나 원래대로 돌아왔으면 기획 담당에게 알릴 안내문
const TOOL_NAME = { claude: "Claude", codex: "Codex" };
function swapNote(st, cfg, eff) {
  const prev = st.applied || { planner: cfg.planner.tool, developer: cfg.developer.tool };
  st.applied = { planner: eff.planner.tool, developer: eff.developer.tool };
  const lines = [];
  if (prev.planner !== eff.planner.tool) {
    lines.push(eff.planner.swappedFrom
      ? `[알림] ${TOOL_NAME[eff.planner.swappedFrom]} 사용량 한도가 차서 기획 담당을 ${TOOL_NAME[eff.planner.tool]}로 잠시 교대했다. 이전 대화 기록이 없으니 docs/PLAN.md, docs/progress.json, docs/reviews/, git log를 확인해 진행 상황을 파악하고 이어서 진행해.`
      : `[알림] ${TOOL_NAME[eff.planner.tool]} 사용량 한도가 초기화되어 원래 기획 담당으로 돌아왔다. 그동안 다른 도구가 진행했으니 docs/PLAN.md, docs/progress.json, git log를 확인하고 이어서 진행해.`);
  }
  if (eff.developer.swappedFrom) {
    lines.push(`[알림] ${TOOL_NAME[eff.developer.swappedFrom]} 사용량 한도로 개발 담당은 당분간 ${TOOL_NAME[eff.developer.tool]}다. ${PLANNER_DOC_NAME}의 개발 명령 대신 아래 명령을 쓰고, 기존 개발 세션 id로 resume하지 말고 새로 시작해 (작업 내용만 바꿔서):\n${devCmd(eff, "<작업 내용>")}`);
  } else if (prev.developer !== eff.developer.tool) {
    lines.push(`[알림] ${TOOL_NAME[eff.developer.tool]} 사용량 한도가 초기화되어 개발 담당이 원래대로 돌아왔다. 다시 ${PLANNER_DOC_NAME}의 개발 명령을 써라 (임시 도구의 세션 id는 쓰지 않는다).`);
  }
  return lines.join("\n");
}
const PLANNER_DOC_NAME = require("./templates").PLANNER_DOC;

// 상단 사용량 기록에 이미 소진으로 나온 도구도 반영 (실행 전에 한도에 걸려 있던 경우)
function syncLimits() {
  const g = readJson(GLOBAL_USAGE, {}), now = Date.now();
  if (g.codex?.exhausted && g.codex.retryAt > now && !fallback.exhaustedUntil("codex")) fallback.markExhausted("codex", g.codex.retryAt, g.codex.message);
  for (const t of ["codex", "claude"]) for (const w of ["five", "week"]) {
    const x = g[t]?.[w];
    if (x && x.used >= 100 && x.resetsAt > now && !fallback.exhaustedUntil(t)) fallback.markExhausted(t, x.resetsAt, `${w} 100%`);
  }
}

// 기획 담당이 쓸 도구가 모두 한도에 걸려 있으면 풀리는 시각까지 기다렸다가 자동으로 이어간다
function waitForReset(dir, cfg, until) {
  const st = state(dir);
  clearTimeout(st.resumeTimer);
  st.status = "limit"; st.resumeAt = until;
  push(st, { src: "system", kind: "system", text: `Claude·Codex 모두 사용량 한도 소진 → ${fallback.hhmm(until)}에 자동으로 이어서 진행합니다` });
  st.resumeTimer = setTimeout(() => { st.resumeTimer = null; st.resumeAt = null; if (st.status === "limit") safeTurn(dir, cfg, nextPrompt(st), false); }, Math.max(0, until - Date.now()) + 60000);
}
// 한도로 끊긴 턴을 다시 돌릴 때: 답만 하던 중이었으면 그 메시지를 다시, 아니면 계속 진행
const nextPrompt = (st) => st.answerOnly || CONTINUE_MSG;

function runTurn(dir, cfg, prompt, { user, build, qa } = {}) {
  const st = state(dir);
  if (st.proc) throw new Error("이미 실행 중입니다");
  if (qa === "deliver") qaDeliver(st);
  if (qa) { push(st, { src: "user", kind: "qa-sent", text: trim(prompt, 200) }); prompt += QA_NOTE; }
  else if (user) push(st, { src: "user", kind: "message", text: trim(prompt) });
  syncLimits();
  const wait = fallback.waitUntil(cfg);
  if (wait) { if (qa) { st.queue.unshift(prompt.slice(0, prompt.length - QA_NOTE.length)); const e = st.qa.find((x) => x.id === st.qaActive); if (e) e.status = "queued"; st.qaActive = null; saveQa(st); } else if (user) st.queue.unshift(prompt); waitForReset(dir, cfg, wait); return st; }
  clearTimeout(st.resumeTimer); st.resumeTimer = null; st.resumeAt = null;
  const eff = fallback.effective(cfg);
  if (eff.planner.swappedFrom && eff.planner.tool !== (st.applied?.planner || cfg.planner.tool))
    push(st, { src: "system", kind: "system", text: `기획 담당: ${TOOL_NAME[eff.planner.swappedFrom]} 한도 소진 → ${TOOL_NAME[eff.planner.tool]}로 전환` });
  if (eff.developer.swappedFrom && eff.developer.tool !== (st.applied?.developer || cfg.developer.tool))
    push(st, { src: "system", kind: "system", text: `개발 담당: ${TOOL_NAME[eff.developer.swappedFrom]} 한도 소진 → ${TOOL_NAME[eff.developer.tool]}로 전환` });
  st.cfgTools = { planner: cfg.planner.tool, developer: cfg.developer.tool };
  const note = swapNote(st, cfg, eff);
  if (note) prompt = `${note}\n\n${prompt}`;
  st.limitHit = null;
  const { args, name } = buildArgs(eff, st, prompt, build);
  if (build) push(st, { src: "system", kind: "system", text: "컨테이너 준비 중 (Dockerfile이 바뀌었으면 이미지를 다시 빌드합니다)" });
  require("./core").ensureVolumes();
  const ps = spawnSync("docker", ["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.State}}"], { encoding: "utf8" });
  const existing = (ps.stdout || "").trim();
  if (existing === "running") throw new Error("이 프로젝트의 기획 담당이 이미 다른 곳(다른 GUI 서버나 창)에서 실행 중입니다. 그쪽에서 중지한 뒤 다시 시도하세요.");
  if (existing) spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" }); // 끝난 채 남은 컨테이너만 정리
  st.status = "running"; st.error = null; st.startedAt = Date.now(); st.lastMessage = ""; st.containerName = name;
  st.cfg = cfg; st.planCur = sessStart(eff.planner.tool);
  // stdin을 닫아야 함: codex exec는 stdin이 파이프면 끝날 때까지 기다렸다가 프롬프트에 덧붙인다
  const proc = spawn("docker", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  st.proc = proc;
  let buf = "", errBuf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { feed(st, "planner", eff.planner.tool, buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  proc.stderr.on("data", (d) => { errBuf = (errBuf + d.toString("utf8")).slice(-4000); });
  proc.on("close", (code) => {
    if (buf) feed(st, "planner", eff.planner.tool, buf);
    st.proc = null;
    pollDev(st); // 개발 담당의 한도 소진도 이번 턴 안에 반영
    refreshUsage(dir, { probe: false }); // 턴이 끝날 때마다 사용량 기록 다시 읽기
    const interrupted = st.interrupting; st.interrupting = false;
    if (st.qaActive && !st.limitHit && !st.stopping && !interrupted) qaAnswer(st, st.lastMessage, "턴 마지막 메시지");
    sessEnd(st, "planner", st.planCur, 0, st.stopping ? "중지" : interrupted ? "메시지로 중단" : null); st.planCur = null;
    if (st.devCur) { sessEnd(st, "developer", st.devCur, 0, "중단"); st.devCur = null; }
    st.devBusy = false;
    if (interrupted && !st.stopping && st.queue.length) { const next = st.queue.shift(); return setImmediate(() => safeTurn(dir, cfg, INTERRUPT_NOTE + next, false, "deliver")); }
    if (st.stopping) { st.stopping = false; st.status = "idle"; push(st, { src: "system", kind: "system", text: "중지됨" }); return; }
    const msg = st.lastMessage || "";
    if (!st.limitHit && code !== 0) limitCheck(st, "planner", eff.planner.tool, errBuf);
    if (st.limitHit) {
      // 한도로 끝난 턴: 다른 도구로 바로 이어가거나, 둘 다 막혔으면 초기화까지 대기 (자동 계속 횟수에 넣지 않는다)
      const wait = fallback.waitUntil(cfg);
      if (wait) return waitForReset(dir, cfg, wait);
      return setTimeout(() => safeTurn(dir, cfg, nextPrompt(st), false), 1500);
    }
    if (code !== 0 && !msg) {
      const err = errBuf.split("\n").filter((l) => l && !/level=warning|Container /.test(l)).slice(-3).join(" ");
      st.status = "error"; st.error = err || `종료 코드 ${code}`;
      push(st, { src: "system", kind: "error", text: `기획 담당 실행 실패: ${st.error}` });
      return;
    }
    if (/\[완료\]/.test(msg)) { st.status = "done"; st.continues = 0; st.answerOnly = null; push(st, { src: "system", kind: "system", text: "모든 작업 완료" }); return; }
    if (st.queue.length) { const next = st.queue.shift(); return setImmediate(() => safeTurn(dir, cfg, next, true, "deliver")); }
    if (/\[질문\]/.test(msg)) { st.answerOnly = null; st.status = "waiting"; push(st, { src: "system", kind: "system", text: "기획 담당이 답변을 기다립니다" }); return; }
    // 멈춰 있을 때 보낸 메시지(진행 상황 질문 등)는 답만 하고 멈춘다 — 자동 "계속 진행"이 새 작업을 시작하지 않게
    if (st.answerOnly) { st.answerOnly = null; st.status = "idle"; push(st, { src: "system", kind: "system", text: "답변 완료 (이어서 진행하려면 ▶ 버튼)" }); return; }
    if (cfg.autoContinue !== false && st.continues < (cfg.maxAutoContinue || 40)) {
      st.continues++;
      push(st, { src: "system", kind: "system", text: `자동 계속 진행 (${st.continues})` });
      return setTimeout(() => safeTurn(dir, cfg, CONTINUE_MSG, false), 1500);
    }
    st.status = "idle";
  });
  return st;
}
function safeTurn(dir, cfg, prompt, user, qa) {
  try { runTurn(dir, cfg, prompt, { user, qa }); }
  catch (e) { const st = state(dir); st.status = "error"; st.error = e.message; push(st, { src: "system", kind: "error", text: e.message }); }
}

// 시작/이어하기
function start(dir, cfg, prompt) {
  const st = state(dir);
  st.continues = 0; st.answerOnly = null;
  const p = prompt || (st.session?.id ? "이어서 진행해. docs/PLAN.md와 docs/progress.json을 확인하고 남은 phase를 계속 진행해." : null);
  return runTurn(dir, cfg, p || require("./core").DEFAULT_PROMPT(cfg), { user: !!prompt, build: true });
}
// 사용자 메시지: 실행 중이면 이번 턴이 끝난 뒤 전달
function send(dir, cfg, text) {
  const st = state(dir);
  st.continues = 0;
  // 완료·대기·오류로 멈춰 있을 때 보낸 메시지는 답만 받는다 (작업 중이거나 [질문]에 답하는 경우는 이어서 진행)
  st.answerOnly = !st.proc && ["done", "idle", "error"].includes(st.status) ? text : null;
  if (st.proc) { st.queue.push(text); qaAdd(st, text, true); push(st, { src: "user", kind: "qa-sent", text: trim(text, 200), queued: true }); pollDev(st); maybeInterrupt(st); return st; }
  qaAdd(st, text, false);
  return runTurn(dir, cfg, text, { user: true, qa: true });
}
function stop(dir) {
  const st = state(dir);
  st.queue = [];
  for (const e of loadQa(st)) if (e.status === "queued") e.status = "cancelled";
  saveQa(st);
  clearTimeout(st.resumeTimer); st.resumeTimer = null; st.resumeAt = null;
  if (st.status === "limit") st.status = "idle";
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
function scanCodexLines(lines, acc, utc = false) {
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
      acc.limitTs = ts; acc.limitMsg = String(err.message || "").slice(0, 200); acc.limitUtc = utc;
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
    // 마지막 rate_limits 기록은 지난 창일 수 있다 → 오류 메시지의 "try again at ..." 시각을 기준으로 한다
    const retry = parseRetry(acc.limitMsg, acc.limitTs, acc.limitUtc);
    data.retryAt = retry;
    const w = retry ? (retry - acc.limitTs > 5 * 3600e3 ? "week" : "five") : (data.week && data.week.used >= 95 ? "week" : "five");
    data[w] = { used: 100, resetsAt: retry || (data[w] && data[w].resetsAt > Date.now() ? data[w].resetsAt : null) };
  }
  return data;
}
// "try again at 10:52 AM" / "try again at Nov 15th, 2026 10:52 AM" → ms (한도에 걸린 시각 이후의 가장 가까운 시점)
function parseRetry(msg, from, utc = false) {
  const m = /try again at ([^.]*?\d{1,2}:\d{2}\s*[AP]M)/i.exec(msg || "");
  if (!m) return null;
  const s = m[1].replace(/(\d)(st|nd|rd|th)/g, "$1");
  const tm = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(s);
  let h = +tm[1] % 12 + (/p/i.test(tm[3]) ? 12 : 0);
  const datePart = s.slice(0, tm.index).replace(/,\s*$/, "").trim();
  let d = datePart ? new Date(`${datePart} 00:00${utc ? " UTC" : ""}`) : new Date(from);
  if (isNaN(d)) d = new Date(from);
  if (utc) d.setUTCHours(h, +tm[2], 0, 0); else d.setHours(h, +tm[2], 0, 0);
  if (!datePart) while (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function scanCodex(dir) {
  const acc = { ts: 0, limitTs: 0 };
  if (hasCompose(dir)) {
    require("./core").ensureVolumes();
    const r = await runAsync(["compose", "run", "--rm", "-T", "dev", "bash", "-lc",
      'fs=$(ls -t $(find ~/.codex/sessions -name "rollout-*.jsonl" 2>/dev/null) 2>/dev/null | head -6); [ -n "$fs" ] && grep -h -E "\\"rate_limits\\"|usage_limit_exceeded" $fs'], dir, 60000);
    scanCodexLines(r.out.split("\n"), acc, true); // 컨테이너는 UTC 시간대로 메시지를 쓴다
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
    if (c.exhausted && c.retryAt && c.retryAt <= Date.now()) c.exhausted = false; // 한도 풀림
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
    current: st.current, seq: st.seq, resumeAt: st.resumeAt || null,
    stats: loadStats(st), qa: loadQa(st).slice(-60), devBusy: !!st.devBusy, devStartedAt: st.devCur ? st.devCur.t0 : null,
    swapped: ["planner", "developer"].filter((r) => st.applied && st.applied[r] !== (st.cfgTools || {})[r]).map((r) => `${r === "planner" ? "기획" : "개발"}: ${TOOL_NAME[st.applied[r]]}로 임시 전환`).join(", "),
    events: st.events.filter((e) => e.seq > since).slice(-300),
  };
}

module.exports = { start, send, stop, reset, view, usage };
