// 설정(config)으로부터 대상 프로젝트에 생성할 파일 내용을 만든다
const { PLATFORMS, common } = require("./platforms");

const DEFAULT_CONFIG = {
  name: "",
  platform: "web",
  planner: { model: "", reasoning: "high" },   // Codex (빈 값 = Codex 기본 모델)
  developer: { model: "sonnet" },               // Claude (opus / sonnet / haiku / 전체 모델 ID)
  git: { visibility: "private", pushOn: "phase", buildCheck: true },
  maxReviewRounds: 3,
  specFile: "docs/SPEC.md",
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

function dockerfile(cfg) {
  const p = PLATFORMS[cfg.platform];
  return `# devagent 생성 파일 - 'devagent apply'로 다시 생성됨
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \\
      git gh ripgrep jq less ca-certificates curl \\
    && rm -rf /var/lib/apt/lists/* \\
    && git config --system safe.directory /workspace \\
    && git config --system credential.https://github.com.helper '!gh auth git-credential'

RUN npm install -g @anthropic-ai/claude-code @openai/codex
${p.docker.length ? "\n# 플랫폼: " + cfg.platform + "\n" + p.docker.join("\n") + "\n" : ""}
USER node
RUN mkdir -p /home/node/.claude /home/node/.codex /home/node/.config/gh
WORKDIR /workspace
CMD ["bash"]
`;
}

function compose(cfg) {
  const p = PLATFORMS[cfg.platform];
  const n = slug(cfg.name);
  const ports = p.ports.length ? `    ports:\n${p.ports.map((x) => `      - "${x}:${x}"`).join("\n")}\n` : "";
  return `# devagent 생성 파일 - 'devagent apply'로 다시 생성됨
services:
  dev:
    build: ./.devcontainer
    image: devagent-${n}
    stdin_open: true
    tty: true
    working_dir: /workspace
    volumes:
      # 이 프로젝트 폴더만 컨테이너에 연결 (호스트의 다른 파일은 보이지 않음)
      - ./:/workspace
      # 로그인 정보: 모든 devagent 프로젝트가 공유 (한 번만 로그인)
      - claude-home:/home/node/.claude
      - codex-home:/home/node/.codex
      - gh-config:/home/node/.config/gh
${ports}
volumes:
  claude-home:
    name: devagent-claude-home
  codex-home:
    name: devagent-codex-home
  gh-config:
    name: devagent-gh-config
`;
}

function claudeCmd(cfg, task) {
  const model = cfg.developer.model ? ` --model ${cfg.developer.model}` : "";
  return `claude -p "${task}"${model} --permission-mode bypassPermissions`;
}

function agentsMd(cfg) {
  const p = PLATFORMS[cfg.platform];
  const push = cfg.git.pushOn !== "never";
  const ci = cfg.git.buildCheck && push;
  const step5 = push
    ? `5. **커밋 & 푸시**: 통과하면 PLAN.md의 해당 phase를 \`- [x]\`로 바꾸고 커밋한 뒤 원격에 올린다.
   \`\`\`bash
   git add -A
   git commit -m "Phase N: <phase 이름>"
   git push
   \`\`\`
   - 커밋 전 \`git status\`로 비밀값(.env, 키 파일 등)이 포함되지 않았는지 확인한다.
${ci ? `   - push 후 GitHub Actions 빌드 결과를 확인한다 (\`gh run watch --exit-status\`, 실패 시 \`gh run view --log-failed\`).
     실패하면 에러 로그를 \`docs/reviews/phase-N.md\`에 붙여 Claude에게 수정 요청 → 다시 커밋/푸시 → 빌드가 성공해야 phase 완료.
` : ""}   - push가 실패하면(인증/원격 미설정 등) 커밋은 유지하고 사용자에게 알린다.`
    : `5. **커밋**: 통과하면 PLAN.md의 해당 phase를 \`- [x]\`로 바꾸고 \`git commit\`한다 (push는 하지 않는다).`;

  return `<!-- devagent 생성 파일 - 'devagent apply'로 다시 생성됨. 수정은 devagent.config.json에서 -->
# 역할: 기획자 겸 리뷰어 (Codex)

너는 이 프로젝트의 기획자이자 리뷰어다. **코드를 직접 작성하지 않는다.** 구현은 셸에서 Claude Code CLI(\`claude -p\`)에게 맡긴다.

- 프로젝트: ${cfg.name}
- 플랫폼: ${p.label}
- 요구사항 명세: \`${cfg.specFile}\`

## 워크플로

1. **분석**: 요구사항 명세를 분석한다. 모호한 점은 시작 전에 사용자에게 질문한다.
2. **계획**: \`docs/PLAN.md\`를 작성한다.
   - 기술 스택, 폴더 구조, 데이터 모델
   - Phase 목록 (각 phase는 독립적으로 검증 가능한 단위, 체크박스 \`- [ ]\`), 각 phase의 완료 기준
   - 작성 후 사용자에게 계획 승인을 받는다.
3. **개발 요청**: 아직 안 끝난 첫 phase를 Claude에게 맡긴다.
   \`\`\`bash
   ${claudeCmd(cfg, "docs/PLAN.md의 Phase N을 구현해. 완료 기준을 모두 충족시키고, 서로 독립적인 작업은 서브 에이전트를 여러 개 띄워 병렬로 진행해도 된다. 끝나면 docs/reports/phase-N.md에 구현 내용·변경 파일·실행/테스트 방법을 요약해.")}
   \`\`\`
4. **검토**: 보고서와 실제 코드를 확인한다.${p.localCheck ? ` 직접 검증도 실행한다: \`${p.localCheck}\`` : ""}
   - 기준: 완료 기준 충족, 버그, 보안, 계획과의 일치
   - 문제가 있으면 \`docs/reviews/phase-N.md\`에 지적 사항을 쓰고 수정 요청:
     \`\`\`bash
     ${claudeCmd(cfg, "docs/reviews/phase-N.md의 리뷰 지적 사항을 반영해 수정하고 docs/reports/phase-N.md를 갱신해.")}
     \`\`\`
   - 통과할 때까지 3~4단계를 반복한다.
${step5}
6. 다음 phase로 넘어간다. 모든 phase가 끝나면 최종 요약을 사용자에게 보고한다.

## 규칙

- 이 작업은 Docker 컨테이너(\`/workspace\`) 안에서만 실행된다. 컨테이너 밖이면 진행하지 말고 사용자에게 알린다.
- ${p.notes}
- 사소한 취향 문제로 반려하지 않는다. 같은 지적이 ${cfg.maxReviewRounds}회 반복되면 사용자에게 판단을 묻는다.
- \`claude\` 실행이 실패하면(사용 한도 초과 등) 진행 상황을 PLAN.md에 기록하고 멈춘 뒤 사용자에게 알린다.
- 작업 재개 시에는 PLAN.md, docs/reviews, docs/reports를 읽고 이어서 진행한다.
`;
}

function claudeMd(cfg) {
  const p = PLATFORMS[cfg.platform];
  return `<!-- devagent 생성 파일 - 'devagent apply'로 다시 생성됨 -->
# 역할: 개발자 (Claude)

- 이 프로젝트의 기획/검토는 Codex가 맡는다. 계획은 \`docs/PLAN.md\`, 리뷰는 \`docs/reviews/\`에 있다.
- 요청받은 phase만 구현하고, 끝나면 \`docs/reports/phase-N.md\`에 구현 내용·변경 파일·실행/테스트 방법을 요약한다.
- 서로 독립적인 작업은 필요하면 서브 에이전트를 여러 개 띄워 병렬로 개발해도 된다. 같은 파일을 동시에 수정하지 않도록 나눈다.
- 플랫폼: ${p.label}. ${p.notes}
- 커밋/푸시는 Codex가 한다. 직접 커밋하지 않는다.
- 계획과 다르게 구현해야 할 이유가 있으면 보고서에 근거를 남긴다.
`;
}

function workflow(cfg) {
  const p = PLATFORMS[cfg.platform];
  return `# devagent 생성 파일 - 'devagent apply'로 다시 생성됨
name: Build Check

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: build-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
${p.workflow}
`;
}

function gitignore(cfg) {
  const p = PLATFORMS[cfg.platform];
  return [...new Set([...common.gitignore, ...p.gitignore])].join("\n") + "\n";
}

function specStub(cfg) {
  return `# ${cfg.name} 요구사항 명세

## 개요
(무엇을 만드는지, 누가 쓰는지)

## 핵심 기능
-

## 화면 / 사용 흐름
-

## 제약 / 기술 선호
- 플랫폼: ${PLATFORMS[cfg.platform].label}
`;
}

// 생성 파일 목록: [경로, 내용, 덮어쓰기여부]
function files(cfg) {
  const out = [
    [".devcontainer/Dockerfile", dockerfile(cfg), true],
    ["docker-compose.yml", compose(cfg), true],
    ["AGENTS.md", agentsMd(cfg), true],
    ["CLAUDE.md", claudeMd(cfg), true],
    [".gitignore", gitignore(cfg), false],
    [".gitattributes", "* text=auto eol=lf\n", false],
    [cfg.specFile, specStub(cfg), false],
  ];
  if (cfg.git.buildCheck && cfg.git.pushOn !== "never") out.push([".github/workflows/build-check.yml", workflow(cfg), true]);
  return out;
}

module.exports = { DEFAULT_CONFIG, files, slug };
