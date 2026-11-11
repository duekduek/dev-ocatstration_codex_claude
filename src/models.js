// 선택 가능한 모델 목록
// Codex: `codex debug models`로 실제 카탈로그를 가져오고, 실패하면 기본 목록 사용
const { spawnSync } = require("child_process");

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

// 호스트의 codex → (없으면) 컨테이너의 codex → 기본 목록
function codexModels(dir) {
  if (cache) return cache;
  const tries = [
    () => spawnSync("codex debug models", { shell: true, encoding: "utf8", timeout: 30000 }),
    () => spawnSync("docker", ["compose", "run", "--rm", "-T", "dev", "codex", "debug", "models"], { cwd: dir, encoding: "utf8", timeout: 120000 }),
  ];
  for (const t of tries) {
    try {
      const r = t();
      if (r.status === 0 && r.stdout.trim().startsWith("{")) return (cache = { source: "codex", models: parseCatalog(r.stdout) });
    } catch {}
  }
  return { source: "fallback", models: FALLBACK_CODEX };
}

module.exports = { CLAUDE_MODELS, codexModels, DEFAULT_LEVELS };
