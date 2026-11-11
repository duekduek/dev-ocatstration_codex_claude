// 모든 플랫폼으로 init을 실행해 생성 파일과 docker compose 설정을 검증
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const core = require("../src/core");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devagent-smoke-"));
const hasDocker = core.dockerOk();
let n = 0;
for (const platform of Object.keys(core.PLATFORMS)) {
  const dir = path.join(root, `app-${platform}`);
  core.init(dir, { platform, developer: { model: "opus" }, planner: { model: "gpt-5.5", reasoning: "medium" } }, () => {});
  for (const f of ["devagent.config.json", ".devcontainer/Dockerfile", "docker-compose.yml", "AGENTS.md", "CLAUDE.md", ".gitignore", "docs/SPEC.md", ".github/workflows/build-check.yml", ".git"])
    assert(fs.existsSync(path.join(dir, f)), `${platform}: ${f} 없음`);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert(agents.includes("--model opus"), `${platform}: AGENTS.md에 Claude 모델 없음`);
  assert(agents.includes("git push"), `${platform}: push 단계 없음`);
  if (hasDocker) {
    const r = spawnSync("docker", ["compose", "config", "-q"], { cwd: dir, encoding: "utf8" });
    assert.strictEqual(r.status, 0, `${platform}: compose 설정 오류 ${r.stderr}`);
  }
  n++;
}

// 설정 변경 → apply 반영 확인
const d = path.join(root, "app-web");
core.apply(d, core.setKey(core.loadConfig(d), "git.pushOn", "never"), () => {});
assert(!fs.existsSync(path.join(d, ".github/workflows/build-check.yml")), "pushOn=never인데 워크플로 남음");
assert(!fs.readFileSync(path.join(d, "AGENTS.md"), "utf8").includes("git push"), "pushOn=never인데 push 단계 남음");

fs.rmSync(root, { recursive: true, force: true });
console.log(`OK: ${n}개 플랫폼 init 검증${hasDocker ? " + docker compose config" : " (Docker 꺼짐: compose 검증 생략)"}, apply 반영 검증`);
