// 설정(config)으로부터 대상 프로젝트에 생성할 파일 내용을 만든다
const { PLATFORMS, common } = require("./platforms");

// 역할별 도구: 기본은 기획/검토=Codex, 개발=Claude. 둘 다 codex 또는 claude로 바꿀 수 있다.
const TOOLS = { codex: "Codex", claude: "Claude" };
const DEFAULT_CONFIG = {
  name: "",
  platform: "web",
  planner: { tool: "codex", model: "", reasoning: "high" },     // model 빈 값 = 도구 기본 모델
  developer: { tool: "claude", model: "sonnet", reasoning: "high" }, // reasoning: codex=model_reasoning_effort, claude=--effort
  git: { visibility: "private", pushOn: "phase", buildCheck: true },
  maxReviewRounds: 3,
  specFile: "docs/SPEC.md",
  autoApprove: true,    // 계획 승인을 묻지 않고 바로 진행
  autoContinue: true,   // 웹 실행 시 턴이 끝나면 자동으로 계속 진행
  maxAutoContinue: 40,
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

# ~/.claude.json 은 볼륨 밖이라 컨테이너마다 사라짐 → 시작 시 Claude가 남긴 백업(볼륨 안)에서 복원
RUN printf '%s\\n' '#!/bin/sh' \\
      'if [ ! -f "$HOME/.claude.json" ]; then b=$(ls -t "$HOME"/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1); [ -n "$b" ] && cp "$b" "$HOME/.claude.json"; fi' \\
      'exec "$@"' > /usr/local/bin/devagent-entry && chmod +x /usr/local/bin/devagent-entry

USER node
RUN mkdir -p /home/node/.claude /home/node/.codex /home/node/.config/gh
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/devagent-entry"]
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
  # 여러 프로젝트가 공유하는 볼륨 (devagent가 미리 생성)
  claude-home:
    name: devagent-claude-home
    external: true
  codex-home:
    name: devagent-codex-home
    external: true
  gh-config:
    name: devagent-gh-config
    external: true
`;
}

// ---------- 역할별 명령 ----------
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

// 개발 담당을 비대화형으로 호출하는 명령 (기획 담당이 셸에서 실행)
// 실행 로그는 .devagent/dev.jsonl 에 남기고(웹 화면 표시용), 기획 담당에게는 최종 답변만 보여준다
function devCmd(cfg, task) {
  const d = cfg.developer;
  const pre = "mkdir -p .devagent && ";
  if (d.tool === "codex") {
    const m = d.model ? ` -m ${d.model}` : "";
    const r = d.reasoning ? ` -c model_reasoning_effort=${q(d.reasoning)}` : "";
    return `${pre}codex exec --json${m}${r} --dangerously-bypass-approvals-and-sandbox ${q(task)} 2>/dev/null | tee -a .devagent/dev.jsonl | jq -rR 'fromjson? | select(.type=="item.completed" and .item.type=="agent_message") | .item.text'`;
  }
  const m = d.model ? ` --model ${d.model}` : "";
  const e = d.reasoning ? ` --effort ${d.reasoning}` : "";
  return `${pre}claude -p ${q(task)}${m}${e} --permission-mode bypassPermissions --output-format stream-json --verbose 2>&1 | tee -a .devagent/dev.jsonl | jq -rR 'fromjson? | select(.type=="result") | .result'`;
}

const PLANNER_DOC = "docs/agents/PLANNER.md";
const DEVELOPER_DOC = "docs/agents/DEVELOPER.md";
const DEV_PREFIX = `${DEVELOPER_DOC}의 개발자 규칙을 따라라.`;

function plannerMd(cfg) {
  const p = PLATFORMS[cfg.platform];
  const P = TOOLS[cfg.planner.tool], D = TOOLS[cfg.developer.tool];
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
     실패하면 에러 로그를 \`docs/reviews/phase-N.md\`에 붙여 개발 담당에게 수정 요청 → 다시 커밋/푸시 → 빌드가 성공해야 phase 완료.
` : ""}   - push가 실패하면(인증/원격 미설정 등) 커밋은 유지하고 사용자에게 알린다.`
    : `5. **커밋**: 통과하면 PLAN.md의 해당 phase를 \`- [x]\`로 바꾸고 \`git commit\`한다 (push는 하지 않는다).`;

  return `<!-- devagent 생성 파일 - 'devagent apply'로 다시 생성됨. 수정은 devagent.config.json에서 -->
# 역할: 기획자 겸 리뷰어 (${P})

너는 이 프로젝트의 기획자이자 리뷰어다. **코드를 직접 작성하지 않는다.** 구현은 셸에서 개발 담당(${D} CLI)을 호출해 맡긴다.

- 프로젝트: ${cfg.name}
- 플랫폼: ${p.label}
- 요구사항 명세: \`${cfg.specFile}\`

## 워크플로

1. **분석**: 요구사항 명세를 분석한다. 모호한 점은 시작 전에 사용자에게 질문한다.
2. **계획**: \`docs/PLAN.md\`를 작성한다.
   - 기술 스택, 폴더 구조, 데이터 모델
   - **Phase를 잘게 나눈다.** 기준:
     - 요구사항 명세의 기능·화면·데이터 항목을 **빠짐없이** phase에 배정하고, PLAN.md에 "요구사항 항목 ↔ phase" 대응표를 넣는다.
     - 한 phase = 화면 하나 또는 기능 하나(+그 테스트). 개발 담당이 **한 번 호출로 끝낼 수 있는 크기**(변경 파일 대략 10개 이내)로 정한다.
     - 큰 기능은 "데이터 모델 → 로직 → 화면 → 연동"처럼 여러 phase로 쪼갠다. 기반 작업(프로젝트 골격, 공통 컴포넌트)은 앞쪽에 둔다.
     - 각 phase에 목표 한 줄, 세부 작업 목록, 완료 기준을 적는다. phase 목록은 \`- [ ] Phase N: 제목\` 체크박스 형식.
${cfg.autoApprove !== false
    ? "   - **승인을 묻지 않는다.** 작성하면 바로 `docs/progress.json`을 만들고(아래 \"진행 상태 기록\") 3단계로 진행한다. 사용자는 웹 화면에서 계획을 본다."
    : "   - 작성 후 사용자에게 계획 승인을 받는다(마지막 줄 [질문]). 승인되면 `docs/progress.json`을 만든다 (아래 \"진행 상태 기록\")."}
3. **개발 요청**: 아직 안 끝난 첫 phase를 개발 담당에게 맡긴다. 호출 전에 progress.json에서 그 phase를 \`in_progress\`로 바꾸고 startedAt을 기록한다.
   \`\`\`bash
   ${devCmd(cfg, `${DEV_PREFIX} docs/PLAN.md의 Phase N을 구현해. 완료 기준을 모두 충족시키고, 끝나면 docs/reports/phase-N.md에 구현 내용·변경 파일·실행/테스트 방법을 요약해.`)}
   \`\`\`
4. **검토**: 개발 담당이 끝나면 progress.json의 status를 \`review\`로 바꾸고, 끝난 세부 작업(tasks)은 done=true로 표시한 뒤 보고서와 실제 코드를 확인한다.${p.localCheck ? ` 직접 검증도 실행한다: \`${p.localCheck}\`` : ""}
   - 기준: 완료 기준 충족, 버그, 보안, 계획과의 일치
   - 문제가 있으면 \`docs/reviews/phase-N.md\`에 지적 사항을 쓰고 수정 요청:
     \`\`\`bash
     ${devCmd(cfg, `${DEV_PREFIX} docs/reviews/phase-N.md의 리뷰 지적 사항을 반영해 수정하고 docs/reports/phase-N.md를 갱신해.`)}
     \`\`\`
   - 수정을 요청할 때는 status를 \`fix\`로 바꾸고 review 경로를 기록한다. 통과할 때까지 3~4단계를 반복한다.
${step5}
   - 완료되면 progress.json의 해당 phase를 \`done\`으로 바꾸고 doneAt, commit(짧은 SHA), report 경로를 기록한다.
6. 다음 phase로 넘어간다. 모든 phase가 끝나면 최종 요약을 사용자에게 보고한다.

## 진행 상태 기록 (docs/progress.json)

사용자는 웹 화면에서 이 파일로 진행 상황을 본다. **상태가 바뀔 때마다 즉시** 갱신한다 (올바른 JSON 유지, 시간은 ISO 8601).
\`\`\`json
{
  "updatedAt": "2026-01-01T09:00:00Z",
  "current": 3,
  "phases": [
    {
      "id": 1,
      "title": "프로젝트 골격",
      "goal": "한 줄 목표",
      "requirements": ["명세 2.1 지도 표시"],
      "tasks": [{ "title": "세부 작업", "done": false }],
      "criteria": ["완료 기준"],
      "status": "todo",
      "startedAt": null, "doneAt": null,
      "commit": null, "report": null, "review": null,
      "note": ""
    }
  ]
}
\`\`\`
- status: \`todo\`(대기) → \`in_progress\`(개발 중) → \`review\`(검토 중) → \`fix\`(수정 요청) → \`done\`(완료). 막히면 \`blocked\` + note에 이유.
- current: 지금 진행 중인 phase id. phase 구성이 바뀌면 PLAN.md와 progress.json을 함께 고친다.
- 멈출 때(사용 한도 등)도 note에 상황을 남긴다.

## 진행 방식 (중요)

- **사용자에게 진행 여부를 묻지 않는다.** "계속할까요?", "다음 phase로 넘어갈까요?" 같은 확인 없이 phase가 끝나면 바로 다음 phase로 진행한다.
- 사용자의 결정이 꼭 필요한 경우(요구사항이 모순되거나 선택에 따라 결과가 크게 달라질 때)만 질문하고, 그때는 메시지 **마지막 줄에 \`[질문]\`**을 쓴다.
- 모든 phase가 끝나면 최종 요약 메시지의 **마지막 줄에 \`[완료]\`**를 쓴다.
- 한 번의 응답에서 가능한 한 많이 진행한다. 응답이 끝나도 [질문]/[완료]가 없으면 자동으로 "계속 진행" 요청이 온다.

## 규칙

- 이 작업은 Docker 컨테이너(\`/workspace\`) 안에서만 실행된다. 컨테이너 밖이면 진행하지 말고 사용자에게 알린다.
- ${p.notes}
- 사소한 취향 문제로 반려하지 않는다. 같은 지적이 ${cfg.maxReviewRounds}회 반복되면 사용자에게 판단을 묻는다([질문]).
- 개발 담당 호출이 실패하면(사용 한도 초과 등) 진행 상황을 PLAN.md에 기록하고 멈춘 뒤 사용자에게 알린다.
- 작업 재개 시에는 PLAN.md, docs/reviews, docs/reports를 읽고 이어서 진행한다.
`;
}

function developerMd(cfg) {
  const p = PLATFORMS[cfg.platform];
  const P = TOOLS[cfg.planner.tool], D = TOOLS[cfg.developer.tool];
  const parallel = cfg.developer.tool === "claude"
    ? "서로 독립적인 작업은 필요하면 서브 에이전트를 여러 개 띄워 병렬로 개발해도 된다. 같은 파일을 동시에 수정하지 않도록 나눈다."
    : "작업을 작은 단위로 나눠 순서대로 구현하고, 단위마다 검증한다.";
  return `<!-- devagent 생성 파일 - 'devagent apply'로 다시 생성됨 -->
# 역할: 개발자 (${D})

- 기획/검토는 ${P}가 맡는다. 계획은 \`docs/PLAN.md\`, 리뷰는 \`docs/reviews/\`에 있다.
- 요청받은 phase만 구현하고, 끝나면 \`docs/reports/phase-N.md\`에 구현 내용·변경 파일·실행/테스트 방법을 요약한다.
- ${parallel}
- 플랫폼: ${p.label}. ${p.notes}
- 커밋/푸시는 기획 담당이 한다. 직접 커밋하지 않는다.
- 계획과 다르게 구현해야 할 이유가 있으면 보고서에 근거를 남긴다.
`;
}

// 각 CLI가 자동으로 읽는 파일: 역할 문서를 가리키기만 한다 (같은 도구가 두 역할을 맡아도 충돌 없음)
function pointerMd(tool, cfg) {
  const roles = [];
  if (cfg.planner.tool === tool) roles.push(`- **기획자/리뷰어**로 시작됐다면(사용자와 대화하며 계획·검토를 맡은 경우): \`${PLANNER_DOC}\`를 읽고 따른다.`);
  if (cfg.developer.tool === tool) roles.push(`- **개발자**로 호출됐다면(특정 phase 구현/수정을 요청받은 경우): \`${DEVELOPER_DOC}\`를 읽고 따른다.`);
  if (!roles.length) roles.push(`- 이 프로젝트에서 ${TOOLS[tool]}는 역할이 없다. 기획은 ${TOOLS[cfg.planner.tool]}, 개발은 ${TOOLS[cfg.developer.tool]}가 맡는다.`);
  return `<!-- devagent 생성 파일 - 'devagent apply'로 다시 생성됨 -->
# devagent 프로젝트 (${TOOLS[tool]})

역할 구성: 기획/검토 = ${TOOLS[cfg.planner.tool]}, 개발 = ${TOOLS[cfg.developer.tool]}

${roles.join("\n")}
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
// 생성 파일 목록: [경로, 내용, 덮어쓰기여부]
function files(cfg) {
  const out = [
    [".devcontainer/Dockerfile", dockerfile(cfg), true],
    ["docker-compose.yml", compose(cfg), true],
    [PLANNER_DOC, plannerMd(cfg), true],
    [DEVELOPER_DOC, developerMd(cfg), true],
    ["AGENTS.md", pointerMd("codex", cfg), true],
    ["CLAUDE.md", pointerMd("claude", cfg), true],
    [".gitignore", gitignore(cfg), false],
    [".gitattributes", "* text=auto eol=lf\n", false],
    [cfg.specFile, specStub(cfg), false],
  ];
  if (cfg.git.buildCheck && cfg.git.pushOn !== "never") out.push([".github/workflows/build-check.yml", workflow(cfg), true]);
  return out;
}

module.exports = { DEFAULT_CONFIG, TOOLS, PLANNER_DOC, DEVELOPER_DOC, files, slug, devCmd };
