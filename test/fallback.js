// 사용량 한도 소진 시 역할 도구 전환 / 대기 로직
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

// 실제 ~/.devagent/limits.json 을 건드리지 않도록 임시 홈에서 실행
const home = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-fallback-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const fb = require("../src/fallback");
assert(fb.LIMITS_FILE.startsWith(home), "임시 홈을 쓰지 않음");

const cfg = {
  planner: { tool: "codex", model: "gpt-6.1-sol", reasoning: "xhigh" },
  developer: { tool: "claude", model: "opus", reasoning: "max" },
};

// 한도 문구 감지
for (const s of ["You've hit your usage limit. Try again at 3:05 PM.", "Claude AI usage limit reached|1760000000", "You've hit your limit · resets 3pm", "usage_limit_exceeded"])
  assert(fb.isLimitText(s), `감지 못함: ${s}`);
for (const s of ["npm ERR! rate of change", "tests passed", ""]) assert(!fb.isLimitText(s), `오탐: ${s}`);

// 아무것도 소진되지 않음 → 그대로
assert.deepStrictEqual(fb.effective(cfg), cfg);
assert.strictEqual(fb.waitUntil(cfg), 0);

// Claude 소진 → 개발 담당만 Codex로, 모델은 Codex 기본값, max 강도는 Codex가 받는 xhigh로
const until = Date.now() + 3600e3;
fb.markExhausted("claude", until, "hit your limit");
let e = fb.effective(cfg);
assert.strictEqual(e.planner.tool, "codex");
assert.deepStrictEqual(e.developer, { tool: "codex", model: "", reasoning: "xhigh", swappedFrom: "claude" });
assert.strictEqual(fb.waitUntil(cfg), 0, "기획 담당(Codex)은 살아 있으니 대기하지 않음");

// 설정의 fallback 모델 사용
e = fb.effective({ ...cfg, fallback: { codex: { model: "gpt-6.1-terra" } } });
assert.strictEqual(e.developer.model, "gpt-6.1-terra");

// 둘 다 소진 → 전환하지 않고 먼저 풀리는 시각까지 대기
const until2 = Date.now() + 7200e3;
fb.markExhausted("codex", until2, "usage limit");
e = fb.effective(cfg);
assert.strictEqual(e.planner.tool, "codex"); assert.strictEqual(e.developer.tool, "claude");
assert.strictEqual(fb.waitUntil(cfg), until);

// Claude 초기화 → Codex만 막힘: 기획 담당은 Claude로, 개발 담당은 원래(Claude)대로
fb.clear("claude");
e = fb.effective(cfg);
assert.strictEqual(e.planner.tool, "claude"); assert.strictEqual(e.planner.swappedFrom, "codex");
assert.strictEqual(e.developer.tool, "claude"); assert(!e.developer.swappedFrom);

// 초기화 시각이 지나면 자동으로 원래대로
fb.markExhausted("codex", Date.now() - 1000, "usage limit"); // 지난 시각 → 기본 5시간으로 잡힘
assert(fb.exhaustedUntil("codex") > Date.now() + 4 * 3600e3);
const l = JSON.parse(fs.readFileSync(fb.LIMITS_FILE, "utf8")); l.codex.until = Date.now() - 1; fs.writeFileSync(fb.LIMITS_FILE, JSON.stringify(l));
assert.deepStrictEqual(fb.effective(cfg), cfg, "초기화 후 원래 설정으로 복귀");

// limitFallback: false → 전환 없이 대기만
fb.markExhausted("codex", until, "usage limit");
assert.deepStrictEqual(fb.effective({ ...cfg, limitFallback: false }), { ...cfg, limitFallback: false });
assert.strictEqual(fb.waitUntil({ ...cfg, limitFallback: false }), until);

// runner가 새 모듈과 함께 문제없이 로드되는지
require("../src/runner");
console.log("fallback OK");
