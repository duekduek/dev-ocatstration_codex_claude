// 사용량 한도(5시간/주간) 소진 시 역할 도구 전환: Claude ⇄ Codex
// 한도는 모델이 아니라 계정(도구) 단위라서, 같은 도구 안에서 모델을 바꾸는 대신 다른 도구로 역할을 넘긴다.
// 소진 정보는 계정 단위라 모든 프로젝트가 공유하도록 ~/.devagent/limits.json 에 저장한다.
const fs = require("fs");
const os = require("os");
const path = require("path");

const LIMITS_FILE = path.join(os.homedir(), ".devagent", "limits.json");
const OTHER = { claude: "codex", codex: "claude" };
const DEFAULT_WAIT = 5 * 3600e3; // 초기화 시각을 모르면 5시간 뒤로 본다
const LIMIT_TEXT = /usage[_ ]limit|hit your (usage )?limit|limit reached|reached your .*limit|out of (extra )?usage/i;

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const load = () => readJson(LIMITS_FILE, {});
function save(l) { try { fs.mkdirSync(path.dirname(LIMITS_FILE), { recursive: true }); fs.writeFileSync(LIMITS_FILE, JSON.stringify(l)); } catch {} }

function markExhausted(tool, until, message) {
  const l = load();
  l[tool] = { until: until && until > Date.now() ? until : Date.now() + DEFAULT_WAIT, message: String(message || "").slice(0, 200), at: Date.now() };
  save(l);
  return l[tool];
}
function clear(tool) { const l = load(); if (l[tool]) { delete l[tool]; save(l); } }
function exhaustedUntil(tool) { const x = load()[tool]; return x && x.until > Date.now() ? x.until : 0; }

// 도구를 바꿀 때 모델은 그 도구의 기본값(설정의 fallback.<tool>.model)을, 추론 강도는 그 도구가 받는 값으로 맞춘다
const EFFORTS = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh"] };
function swapRole(cfg, role) {
  const r = cfg[role], to = OTHER[r.tool];
  const fb = (cfg.fallback && cfg.fallback[to]) || {};
  const reasoning = EFFORTS[to].includes(r.reasoning) ? r.reasoning : "xhigh";
  return { tool: to, model: fb.model || "", reasoning: fb.reasoning || reasoning, swappedFrom: r.tool };
}
// 이번 턴에 실제로 쓸 설정: 한도가 찬 도구는 다른 도구로(그쪽도 차 있으면 원래대로 두고 대기)
function effective(cfg) {
  if (cfg.limitFallback === false) return cfg;
  const out = { ...cfg };
  for (const role of ["planner", "developer"]) {
    const t = cfg[role].tool;
    if (exhaustedUntil(t) && !exhaustedUntil(OTHER[t])) out[role] = swapRole(cfg, role);
  }
  return out;
}
// 기획 담당이 쓸 도구가 모두 막혀 있으면 가장 먼저 풀리는 시각, 아니면 0
function waitUntil(cfg) {
  const a = exhaustedUntil(cfg.planner.tool), b = exhaustedUntil(OTHER[cfg.planner.tool]);
  if (cfg.limitFallback === false) return a;
  return a && b ? Math.min(a, b) : 0;
}

const isLimitText = (s) => LIMIT_TEXT.test(String(s || ""));
const hhmm = (ms) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

module.exports = { LIMITS_FILE, OTHER, markExhausted, clear, exhaustedUntil, effective, waitUntil, isLimitText, hhmm };
