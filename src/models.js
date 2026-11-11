// 선택 가능한 모델 목록
// Codex: `codex debug models`로 실제 카탈로그를 가져오고, 실패하면 기본 목록 사용
const { spawnSync } = require("child_process");

const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"]; // claude --effort
const CLAUDE_MODELS = [
  { id: "sonnet", label: "Sonnet (최신, 권장 - 속도/사용량 균형)" },
  { id: "opus", label: "Opus (최신, 고품질 - 사용량 많음)" },
  { id: "haiku", label: "Haiku (최신, 빠르고 가벼움)" },
  { id: "fable", label: "Fable (최신)" },
  { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5 (버전 고정)" },
  { id: "claude-opus-5-5", label: "claude-opus-5-5 (버전 고정)" },
  { id: "claude-haiku-5-5", label: "claude-haiku-5-5 (버전 고정)" },
  { id: "claude-fable-5-2", label: "claude-fable-5-2 (버전 고정)" },
];

const DEFAULT_LEVELS = ["low", "medium", "high", "xhigh"];
const FALLBACK_CODEX = [
  { id: "", label: "Codex 기본 모델", levels: DEFAULT_LEVELS, defaultLevel: "high" },
];

let cache = null;
function parseCatalog(text) {
  const j = JSON.parse(text);
  const list = (j.models || j).filter((m) => m.visibility !== "hide");
  return [
    { id: "", label: "Codex 기본 모델 (config.toml)", levels: DEFAULT_LEVELS, defaultLevel: "high" },
    ...list.map((m) => ({
      id: m.slug,
      label: `${m.display_name || m.slug} - ${m.description || ""}`.trim(),
      levels: (m.supported_reasoning_levels || []).map((x) => x.effort),
      defaultLevel: m.default_reasoning_level || "medium",
    })),
  ];
}

const fs = require("fs");
const path = require("path");
const hasProject = (dir) => fs.existsSync(path.join(dir, "docker-compose.yml"));
const inContainer = (dir, args, timeout = 120000) =>
  spawnSync("docker", ["compose", "run", "--rm", "-T", "dev", ...args], { cwd: dir, encoding: "utf8", timeout });

// 로그인된 계정 기준 Codex 모델 카탈로그
// 컨테이너(개발에 실제로 쓰는 계정) → 호스트 codex → 기본 목록
function codexModels(dir, { refresh } = {}) {
  if (cache && !refresh) return cache;
  const tries = [];
  if (hasProject(dir)) tries.push(["container", () => inContainer(dir, ["codex", "debug", "models"])]);
  tries.push(["host", () => spawnSync("codex debug models", { shell: true, encoding: "utf8", timeout: 30000 })]);
  const errors = [];
  for (const [where, t] of tries) {
    try {
      const r = t();
      if (r.status === 0 && r.stdout.trim().startsWith("{")) return (cache = { source: where, models: parseCatalog(r.stdout) });
      errors.push(`${where}: ${(r.stderr || r.error?.message || "실패").trim().split("\n").pop()}`);
    } catch (e) { errors.push(`${where}: ${e.message}`); }
  }
  return { source: "fallback", models: FALLBACK_CODEX, errors };
}

// 로그인된 계정으로 모델을 실제 호출해 사용 가능 여부 확인 (토큰 소량 사용)
function verifyModel(dir, tool, model) {
  if (!hasProject(dir)) return { ok: false, message: "devagent 설정이 없는 폴더입니다 (설정 저장 먼저)" };
  if (!/^[\w.:-]*$/.test(model || "")) return { ok: false, message: "잘못된 모델 이름" };
  if (tool === "claude") {
    const args = ["claude", "-p", "Reply with just OK", "--output-format", "json", "--max-turns", "1"];
    if (model) args.push("--model", model);
    const r = inContainer(dir, args);
    try {
      const j = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop());
      const used = Object.keys(j.modelUsage || {});
      return j.is_error ? { ok: false, message: j.result } : { ok: true, message: `사용 가능${used.length ? ` → 실제 모델: ${used.join(", ")}` : ""}` };
    } catch { return { ok: false, message: (r.stderr || r.stdout || "응답 없음").trim().slice(-300) }; }
  }
  if (tool === "codex") {
    const args = ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "Reply with just OK"];
    if (model) args.splice(2, 0, "-m", model);
    const r = inContainer(dir, args);
    return r.status === 0 ? { ok: true, message: "사용 가능" } : { ok: false, message: (r.stderr || r.stdout || "실패").trim().split("\n").slice(-3).join(" ").slice(-300) };
  }
  return { ok: false, message: "unknown tool" };
}

// 도구별 모델 목록 (GUI/CLI 공통 형식: {id, label, levels?, defaultLevel?})
function modelsFor(tool, dir, opts) {
  if (tool === "claude") return { source: "builtin", models: CLAUDE_MODELS.map((m) => ({ ...m, levels: CLAUDE_LEVELS, defaultLevel: "high" })) };
  return codexModels(dir, opts);
}

module.exports = { CLAUDE_MODELS, codexModels, modelsFor, verifyModel, DEFAULT_LEVELS };
