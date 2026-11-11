// 진행 상황 수집: phase, 실행 중인 에이전트, 최근 변경 파일, 기록(커밋/보고서/리뷰), CI
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const sh = (cmd, args, cwd, timeout = 15000) => {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
};

// 기획 담당이 기록하는 docs/progress.json (상태·세부 작업 포함) → 없거나 깨졌으면 PLAN.md 체크박스
const STATUSES = ["todo", "in_progress", "review", "fix", "done", "blocked"];
function phases(dir) {
  const pj = path.join(dir, "docs", "progress.json");
  if (fs.existsSync(pj)) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, "utf8"));
      const items = (j.phases || []).map((p, i) => ({
        id: p.id ?? i + 1,
        title: String(p.title || `Phase ${i + 1}`),
        goal: p.goal || "",
        status: STATUSES.includes(p.status) ? p.status : "todo",
        done: p.status === "done",
        tasks: Array.isArray(p.tasks) ? p.tasks.map((t) => (typeof t === "string" ? { title: t, done: false } : { title: String(t.title || ""), done: !!t.done })) : [],
        requirements: Array.isArray(p.requirements) ? p.requirements.map(String) : [],
        startedAt: p.startedAt || null, doneAt: p.doneAt || null,
        commit: p.commit || null, report: p.report || null, review: p.review || null, note: p.note || "",
      }));
      let current = items.findIndex((x) => x.id === j.current && !x.done);
      if (current < 0) current = items.findIndex((x) => ["in_progress", "review", "fix", "blocked"].includes(x.status));
      if (current < 0) current = items.findIndex((x) => !x.done);
      return { exists: true, source: "progress.json", items, done: items.filter((x) => x.done).length, current, updated: fs.statSync(pj).mtimeMs };
    } catch (e) {
      // 기록 도중 읽으면 JSON이 잠깐 깨질 수 있음 → PLAN.md로 대체
    }
  }
  const f = path.join(dir, "docs", "PLAN.md");
  if (!fs.existsSync(f)) return { exists: false, items: [] };
  const items = [];
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) items.push({ done: m[1] !== " ", status: m[1] !== " " ? "done" : "todo", tasks: [], title: m[2].replace(/\*\*/g, "").trim() });
  }
  const current = items.findIndex((x) => !x.done);
  if (current >= 0) items[current].status = "in_progress";
  return { exists: true, source: "PLAN.md", items, done: items.filter((x) => x.done).length, current, updated: fs.statSync(f).mtimeMs };
}

// 이 프로젝트의 컨테이너와 그 안에서 돌고 있는 codex/claude 프로세스
function agents(dir) {
  const project = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const out = sh("docker", ["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}|{{.Names}}|{{.RunningFor}}"], dir);
  if (out === null) return { docker: false, containers: [] };
  const containers = out.trim().split("\n").filter(Boolean).map((l) => {
    const [id, name, since] = l.split("|");
    // 기본 docker top 출력의 CMD 열 (Docker Desktop은 -eo 옵션 미지원)
    const top = (sh("docker", ["top", id], dir) || "").split("\n");
    const col = (top[0] || "").indexOf("CMD");
    const procs = col < 0 ? [] : top.slice(1).map((l) => l.slice(col).trim()).filter((a) => /\b(codex|claude)\b/.test(a));
    const roles = [];
    for (const a of procs) {
      if (/\bclaude\b.*\s-p\s|\bcodex\b\s+exec\b/.test(a)) roles.push({ role: "개발", tool: /claude/.test(a) ? "Claude" : "Codex" });
      else if (/\b(codex|claude)\b/.test(a) && !/\bdebug\b|\blogin\b|\bauth\b/.test(a)) roles.push({ role: "기획/검토", tool: /claude/.test(a) ? "Claude" : "Codex" });
    }
    // 중복 제거
    const uniq = [...new Map(roles.map((r) => [r.role + r.tool, r])).values()];
    return { name, since, roles: uniq };
  });
  return { docker: true, containers };
}

// 최근 수정된 파일 (에이전트가 지금 무엇을 만지는지)
const SKIP = new Set([".git", "node_modules", ".devcontainer", "build", "dist", ".next", "DerivedData", ".gradle", "target", ".dart_tool", ".venv", "__pycache__", ".agents", ".claude"]);
function recentFiles(dir, limit = 12) {
  const files = [];
  (function walk(d, depth) {
    if (depth > 8) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { try { files.push({ path: path.relative(dir, p).replace(/\\/g, "/"), mtime: fs.statSync(p).mtimeMs }); } catch {} }
    }
  })(dir, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// 타임라인: 커밋 + 보고서/리뷰 파일
function timeline(dir, limit = 20) {
  const ev = [];
  const log = sh("git", ["log", "-n", "15", "--format=%H|%ct|%s"], dir);
  if (log) for (const l of log.trim().split("\n").filter(Boolean)) {
    const [sha, t, ...s] = l.split("|");
    ev.push({ type: "commit", time: Number(t) * 1000, title: s.join("|"), sha: sha.slice(0, 7) });
  }
  for (const [sub, type] of [["reports", "report"], ["reviews", "review"]]) {
    const d = path.join(dir, "docs", sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".md")) ev.push({ type, time: fs.statSync(path.join(d, f)).mtimeMs, title: f, path: `docs/${sub}/${f}` });
  }
  const plan = path.join(dir, "docs", "PLAN.md");
  if (fs.existsSync(plan)) ev.push({ type: "plan", time: fs.statSync(plan).mtimeMs, title: "PLAN.md 갱신", path: "docs/PLAN.md" });
  return ev.sort((a, b) => b.time - a.time).slice(0, limit);
}

// GitHub Actions: PC의 gh → 실패 시 생략 (CI는 캐시해서 너무 자주 호출하지 않음)
const ciCache = new Map();
function ci(dir) {
  const c = ciCache.get(dir);
  if (c && Date.now() - c.at < 30000) return c.data;
  const out = sh("gh", ["run", "list", "-L", "5", "--json", "status,conclusion,displayTitle,createdAt,url,workflowName"], dir, 20000);
  let data = null;
  try { data = out ? JSON.parse(out) : null; } catch {}
  ciCache.set(dir, { at: Date.now(), data });
  return data;
}

function progress(dir) {
  return { at: Date.now(), phases: phases(dir), agents: agents(dir), recent: recentFiles(dir), timeline: timeline(dir), ci: ci(dir) };
}

module.exports = { progress };
