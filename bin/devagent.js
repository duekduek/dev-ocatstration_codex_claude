#!/usr/bin/env node
// devagent CLI
const path = require("path");
const readline = require("readline/promises");
const core = require("../src/core");

const HELP = `devagent - Codex(기획/리뷰) + Claude(개발) 멀티 에이전트 개발 환경

사용법: devagent <명령> [옵션]

  init [폴더]        새 프로젝트 설정 (대화형, 또는 옵션으로 지정)
  apply              devagent.config.json 기준으로 생성 파일 다시 만들기
  set <키> <값>      설정 변경 후 apply (예: set developer.model opus)
  models             선택 가능한 모델/플랫폼 보기
  login [--no-import] Docker 이미지 빌드 + 로그인 (PC에 로그인돼 있으면 그대로 가져옴)
  repo               GitHub 저장소 생성(기본 private) + 첫 커밋/푸시
  start [프롬프트]    컨테이너 안에서 Codex 실행 (기본: 개발 시작/이어하기)
  shell              컨테이너 셸 열기
  status             설정/로그인/저장소 상태
  doctor [--json]    환경 점검 (Docker 등 설치 여부, 플랫폼별 실행 가능 범위)
  install-skill      Claude Code 스킬(/devagent) 설치
  gui [--port N]     웹 GUI 열기 (기본 http://127.0.0.1:4317)

init 옵션:
  --name <이름> --platform <${Object.keys(core.PLATFORMS).join("|")}>
  --planner-tool <codex|claude> (기본 codex)  --planner-model <모델> --reasoning <강도>
  --dev-tool <claude|codex> (기본 claude)     --dev-model <모델> --dev-reasoning <강도>
  --visibility <private|public>
  --push-on <phase|never> --no-build-check --spec <파일> --yes

공통 옵션: --dir <프로젝트 폴더> (기본: 현재 폴더)
`;

function parse(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["yes", "no-build-check", "help", "json", "no-import"].includes(k)) o[k] = true;
      else o[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, o };
}

async function ask(rl, q, def, choices) {
  const hint = choices ? ` (${choices.join(" / ")})` : "";
  const a = (await rl.question(`${q}${hint} [${def}]: `)).trim();
  return a || def;
}

async function initCmd(dir, o) {
  const cur = core.loadConfig(dir) || core.DEFAULT_CONFIG;
  const opts = {
    name: o.name || cur.name || path.basename(path.resolve(dir)),
    platform: o.platform || cur.platform,
    planner: { tool: o["planner-tool"] || cur.planner.tool, model: o["planner-model"] ?? cur.planner.model, reasoning: o.reasoning || cur.planner.reasoning },
    developer: { tool: o["dev-tool"] || cur.developer.tool, model: o["dev-model"] ?? cur.developer.model, reasoning: o["dev-reasoning"] || cur.developer.reasoning },
    git: { visibility: o.visibility || cur.git.visibility, pushOn: o["push-on"] || cur.git.pushOn, buildCheck: o["no-build-check"] ? false : cur.git.buildCheck },
    specFile: o.spec || cur.specFile,
  };
  if (!o.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n플랫폼:");
    for (const [k, p] of Object.entries(core.PLATFORMS)) console.log(`  ${k.padEnd(13)} ${p.label}`);
    opts.name = await ask(rl, "\n프로젝트 이름", opts.name);
    opts.platform = await ask(rl, "플랫폼", opts.platform);
    const M = require("../src/models");
    for (const [role, label, prev] of [["planner", "기획/검토", cur.planner], ["developer", "개발", cur.developer]]) {
      const r = opts[role];
      r.tool = await ask(rl, `${label} 담당 도구`, r.tool, Object.keys(core.TOOLS));
      if (r.tool !== prev.tool && !o[role === "planner" ? "planner-model" : "dev-model"]) r.model = r.tool === "claude" ? "sonnet" : "";
      const list = M.modelsFor(r.tool, dir).models.map((m) => m.id).filter(Boolean).slice(0, 6);
      r.model = await ask(rl, `${label} 모델 (${core.TOOLS[r.tool]}, 비우려면 '-')`, r.model || "-", list);
      if (r.model === "-") r.model = "";
      if (r.tool === "codex") r.reasoning = await ask(rl, `${label} 추론 강도`, r.reasoning, core.MODEL_HINTS.reasoning);
    }
    opts.git.visibility = await ask(rl, "GitHub 저장소 공개 여부", opts.git.visibility, ["private", "public"]);
    opts.git.pushOn = await ask(rl, "phase 완료 시 push", opts.git.pushOn, ["phase", "never"]);
    opts.git.buildCheck = (await ask(rl, "GitHub Actions 빌드 확인", opts.git.buildCheck ? "y" : "n", ["y", "n"])) === "y";
    opts.specFile = await ask(rl, "요구사항 명세 파일", opts.specFile);
    rl.close();
  }
  console.log(`\n${path.resolve(dir)} 에 생성:`);
  const cfg = core.init(dir, opts);
  console.log(`\n다음 단계:
  1. ${cfg.specFile} 에 요구사항 작성
  2. devagent login   (Docker 빌드 + 로그인)
  3. devagent repo    (GitHub ${cfg.git.visibility} 저장소 생성)
  4. devagent start   (${core.TOOLS[cfg.planner.tool]}가 기획 → ${core.TOOLS[cfg.developer.tool]} 개발 → 검토 → phase별 push)`);
}

async function main() {
  const { pos, o } = parse(process.argv.slice(2));
  const cmd = pos[0];
  const dir = path.resolve(o.dir || (cmd === "init" && pos[1]) || ".");
  if (!cmd || o.help || cmd === "help") return console.log(HELP);

  switch (cmd) {
    case "init": return initCmd(dir, o);
    case "apply": { const cfg = core.loadConfig(dir); if (!cfg) throw new Error("devagent.config.json 없음 - init 먼저"); return core.apply(dir, cfg); }
    case "set": {
      if (pos.length < 3) throw new Error("사용법: devagent set <키> <값>");
      const cfg = core.loadConfig(dir); if (!cfg) throw new Error("devagent.config.json 없음 - init 먼저");
      core.apply(dir, core.setKey(cfg, pos[1], pos[2]));
      return console.log(`${pos[1]} = ${pos[2]} 적용됨`);
    }
    case "models": {
      const M = require("../src/models");
      console.log("Claude(개발) developer.model:");
      for (const m of M.CLAUDE_MODELS) console.log(`  ${m.id.padEnd(20)} ${m.label}`);
      const cx = M.codexModels(dir);
      console.log(`\nCodex(기획) planner.model ${cx.source === "fallback" ? "(codex 목록을 가져오지 못함)" : ""}:`);
      for (const m of cx.models) console.log(`  ${(m.id || '""').padEnd(20)} ${m.label}\n${"".padEnd(23)}추론: ${m.levels.join(", ")} (기본 ${m.defaultLevel})`);
      console.log("\n플랫폼 platform:");
      for (const [k, p] of Object.entries(core.PLATFORMS)) console.log(`  ${k.padEnd(13)} ${p.label}`);
      return;
    }
    case "login": core.login(dir, console.log, { importHost: !o["no-import"] }); return;
    case "repo": core.repo(dir); return;
    case "start": process.exitCode = core.start(dir, { prompt: pos[1] }); return;
    case "shell": process.exitCode = core.start(dir, { shell: true }); return;
    case "status": {
      const s = core.status(dir);
      if (!s.config) return console.log("devagent 프로젝트가 아닙니다 (init 필요).");
      const c = s.config, L = s.login;
      console.log(`프로젝트  ${c.name} (${c.platform}) - ${s.dir}
기획/검토 ${core.TOOLS[c.planner.tool]} ${c.planner.model || "(기본 모델)"}${c.planner.tool === "codex" ? ` [${c.planner.reasoning}]` : ""}
개발      ${core.TOOLS[c.developer.tool]} ${c.developer.model || "(기본 모델)"}${c.developer.tool === "codex" ? ` [${c.developer.reasoning}]` : ""}
Git       ${c.git.visibility}, push: ${c.git.pushOn}, 빌드확인: ${c.git.buildCheck ? "on" : "off"}
원격      ${s.remote || "(없음 - devagent repo)"}
최근커밋  ${s.lastCommit || "(없음)"}
Docker    ${s.docker ? "실행 중" : "꺼짐"}
로그인    ${L ? `Claude ${L.claude ? "O" : "X"} / Codex ${L.codex ? "O" : "X"} / GitHub ${L.gh ? "O" : "X"}` : "(이미지 없음 - devagent login)"}`);
      return;
    }
    case "doctor": {
      const r = require("../src/doctor").doctor(dir);
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`호스트: ${r.host} (${r.os})`);
      for (const c of r.checks) console.log(`  ${c.ok ? "OK " : "XX "} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n       → 설치/해결: ${c.fix}` : ""}`);
      if (r.project) console.log(`\n프로젝트 ${r.project.name} (${r.project.platform})`);
      if (r.platformAdvice) console.log(`  [${r.platformAdvice.level}] ${r.platformAdvice.msg}`);
      console.log(`\n${r.ready ? "준비 완료" : "위 항목을 해결한 뒤 다시 실행하세요"}`);
      if (!r.ready) process.exitCode = 2;
      return;
    }
    case "install-skill": {
      const fs = require("fs"), os = require("os");
      const src = path.join(__dirname, "..", "skills", "devagent", "SKILL.md");
      const dest = path.join(os.homedir(), ".claude", "skills", "devagent");
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, "SKILL.md"));
      return console.log(`스킬 설치됨: ${dest}\\SKILL.md\nClaude Code에서 /devagent 로 사용하세요.`);
    }
    case "gui": return require("../src/gui/server").serve({ dir, port: Number(o.port) || 4317 });
    default: console.log(`알 수 없는 명령: ${cmd}\n`); console.log(HELP); process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`오류: ${e.message}`); process.exitCode = 1; });
