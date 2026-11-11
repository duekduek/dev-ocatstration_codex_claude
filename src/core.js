// devagent 핵심 동작: 설정 파일, 파일 생성, Docker/로그인/저장소/실행
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const { DEFAULT_CONFIG, files, slug } = require("./templates");
const { PLATFORMS } = require("./platforms");

const CONFIG_FILE = "devagent.config.json";
const COAUTHOR = "Co-Authored-By: devagent (Codex + Claude)";

const MODEL_HINTS = {
  developer: ["sonnet", "opus", "haiku", "(전체 모델 ID도 가능, 예: claude-sonnet-5-5)"],
  // 예시 값. 실제 사용 가능한 이름은 컨테이너에서 codex 실행 후 /model 로 확인
  planner: ["(빈 값 = Codex 기본 모델)", "gpt-5.5", "gpt-5.5-codex", "o3"],
  reasoning: ["low", "medium", "high", "xhigh"],
};

// ---------- 설정 ----------
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  return out;
}
function loadConfig(dir) {
  const f = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(f)) return null;
  return merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(f, "utf8")));
}
function saveConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + "\n");
}
function validate(cfg) {
  if (!PLATFORMS[cfg.platform]) throw new Error(`알 수 없는 플랫폼: ${cfg.platform} (가능: ${Object.keys(PLATFORMS).join(", ")})`);
  if (!["private", "public"].includes(cfg.git.visibility)) throw new Error("git.visibility는 private 또는 public");
  if (!["phase", "never"].includes(cfg.git.pushOn)) throw new Error("git.pushOn은 phase 또는 never");
  if (!cfg.name) throw new Error("name(프로젝트 이름)이 필요합니다");
  return cfg;
}
function setKey(cfg, key, value) {
  const parts = key.split(".");
  let o = cfg;
  for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
  const last = parts.at(-1);
  o[last] = value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value;
  return cfg;
}

// ---------- 파일 생성 ----------
function apply(dir, cfg, log = console.log) {
  validate(cfg);
  saveConfig(dir, cfg);
  for (const [rel, content, overwrite] of files(cfg)) {
    const f = path.join(dir, rel);
    if (rel === ".gitignore" && fs.existsSync(f)) {
      // 기존 내용은 유지하고 플랫폼에 필요한 항목만 추가
      const cur = fs.readFileSync(f, "utf8");
      const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
      const add = content.split("\n").filter((l) => l && !have.has(l));
      if (add.length) { fs.writeFileSync(f, cur.replace(/\s*$/, "\n") + add.join("\n") + "\n"); log(`  추가  .gitignore (+${add.length})`); }
      else log("  유지  .gitignore");
      continue;
    }
    if (fs.existsSync(f) && !overwrite) { log(`  유지  ${rel}`); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    log(`  생성  ${rel}`);
  }
  // 플랫폼 변경 등으로 필요 없어진 빌드 워크플로 제거
  const wf = path.join(dir, ".github/workflows/build-check.yml");
  if (!(cfg.git.buildCheck && cfg.git.pushOn !== "never") && fs.existsSync(wf)) { fs.unlinkSync(wf); log("  삭제  .github/workflows/build-check.yml"); }
  if (!fs.existsSync(path.join(dir, ".git"))) {
    run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    log("  git init (main)");
  }
}

function init(dir, opts, log = console.log) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = merge(loadConfig(dir) || DEFAULT_CONFIG, opts);
  if (!cfg.name) cfg.name = path.basename(path.resolve(dir));
  apply(dir, cfg, log);
  return cfg;
}

// ---------- 프로세스 ----------
function run(cmd, args, { cwd, input, inherit } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} 실행 실패: ${r.error.message}`);
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const dc = (dir, args, o = {}) => run("docker", ["compose", ...args], { cwd: dir, ...o });
const inContainer = (dir, script, o = {}) => dc(dir, ["run", "--rm", ...(o.extra || []), "dev", "bash", "-lc", script], o);

function dockerOk() {
  try { return run("docker", ["info", "--format", "{{.ServerVersion}}"]).code === 0; } catch { return false; }
}
function requireDocker() {
  if (!dockerOk()) throw new Error("Docker가 실행 중이 아닙니다. Docker Desktop을 켜고 다시 시도하세요.");
}
function requireConfig(dir) {
  const cfg = loadConfig(dir);
  if (!cfg) throw new Error(`${CONFIG_FILE}이 없습니다. 먼저 'devagent init'을 실행하세요.`);
  return cfg;
}

function build(dir, log = console.log) {
  requireDocker(); requireConfig(dir);
  log("Docker 이미지 빌드 중… (처음엔 몇 분 걸립니다)");
  const r = dc(dir, ["build"], { inherit: true });
  if (r.code !== 0) throw new Error("이미지 빌드 실패");
}

function loginStatus(dir) {
  const r = inContainer(dir, `
    claude auth status 2>/dev/null | grep -q '"loggedIn": true' && echo claude=yes || echo claude=no
    codex login status >/dev/null 2>&1 && echo codex=yes || echo codex=no
    gh auth status >/dev/null 2>&1 && echo gh=yes || echo gh=no`);
  const s = {};
  for (const m of r.out.matchAll(/(claude|codex|gh)=(yes|no)/g)) s[m[1]] = m[2] === "yes";
  return s;
}

// 대화형 로그인 (터미널 필요)
function login(dir, log = console.log) {
  build(dir, log);
  const s = loginStatus(dir);
  log(`현재 로그인: Claude ${s.claude ? "O" : "X"} / Codex ${s.codex ? "O" : "X"} / GitHub ${s.gh ? "O" : "X"}`);

  if (!s.codex) {
    const hostAuth = path.join(os.homedir(), ".codex", "auth.json");
    if (fs.existsSync(hostAuth)) {
      log("PC의 Codex 로그인 정보를 컨테이너로 복사합니다.");
      inContainer(dir, "cp /tmp/host-codex-auth.json ~/.codex/auth.json && chmod 600 ~/.codex/auth.json", { extra: ["-v", `${hostAuth}:/tmp/host-codex-auth.json:ro`] });
    } else {
      log("Codex 로그인: 브라우저에서 링크를 열고 코드를 입력하세요. (ChatGPT 보안 설정에서 기기 코드 로그인 허용 필요)");
      inContainer(dir, "codex login --device-auth", { inherit: true });
    }
  }
  if (!s.claude) { log("Claude 로그인: 링크를 열어 로그인한 뒤 코드를 붙여넣으세요."); inContainer(dir, "claude auth login", { inherit: true }); }
  if (!s.gh) { log("GitHub 로그인: 코드를 github.com/login/device 에 입력하세요."); inContainer(dir, "gh auth login -h github.com -p https -w", { inherit: true }); }

  const f = loginStatus(dir);
  log(`최종 로그인: Claude ${f.claude ? "O" : "X"} / Codex ${f.codex ? "O" : "X"} / GitHub ${f.gh ? "O" : "X"}`);
  return f;
}

// GitHub 저장소 생성 + 첫 커밋/푸시
function repo(dir, log = console.log) {
  requireDocker();
  const cfg = requireConfig(dir);
  const name = slug(cfg.name);
  const r = inContainer(dir, `set -e
    if git remote get-url origin >/dev/null 2>&1; then echo "REMOTE=$(git remote get-url origin)"; exit 0; fi
    LOGIN=$(gh api user -q .login); ID=$(gh api user -q .id)
    git config user.name "$LOGIN"; git config user.email "$ID+$LOGIN@users.noreply.github.com"
    git add -A
    git diff --cached --quiet || git commit -q -m "Initial setup by devagent" -m "${COAUTHOR}"
    gh repo create "${name}" --${cfg.git.visibility} --source=. --remote=origin --push >/dev/null
    echo "REMOTE=$(git remote get-url origin)"`);
  if (r.code !== 0) throw new Error(`저장소 생성 실패: ${r.err || r.out}`);
  const remote = (r.out.match(/REMOTE=(.*)/) || [])[1];
  log(`원격 저장소: ${remote}`);
  return remote;
}

function codexArgs(cfg, prompt) {
  const a = ["codex", "--dangerously-bypass-approvals-and-sandbox"];
  if (cfg.planner.model) a.push("-m", cfg.planner.model);
  if (cfg.planner.reasoning) a.push("-c", `model_reasoning_effort="${cfg.planner.reasoning}"`);
  if (prompt) a.push(prompt);
  return a;
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function startScript(cfg, prompt) { return codexArgs(cfg, prompt).map(shq).join(" "); }
const DEFAULT_PROMPT = (cfg) => `${cfg.specFile} 요구사항으로 AGENTS.md 워크플로대로 개발 시작해. 이미 진행 중이면 PLAN.md를 읽고 이어서 진행해.`;

// 컨테이너 안에서 Codex 실행 (대화형)
function start(dir, { prompt, shell } = {}) {
  requireDocker();
  const cfg = requireConfig(dir);
  const script = shell ? "bash" : startScript(cfg, prompt === undefined ? DEFAULT_PROMPT(cfg) : prompt);
  return dc(dir, ["run", "--rm", "dev", "bash", "-lc", script], { inherit: true }).code;
}

function status(dir) {
  const cfg = loadConfig(dir);
  const out = { dir: path.resolve(dir), config: cfg, docker: dockerOk(), login: null, remote: null, lastCommit: null };
  if (fs.existsSync(path.join(dir, ".git"))) {
    out.remote = run("git", ["remote", "get-url", "origin"], { cwd: dir }).out || null;
    out.lastCommit = run("git", ["log", "--oneline", "-1"], { cwd: dir }).out || null;
  }
  if (cfg && out.docker && run("docker", ["image", "inspect", `devagent-${slug(cfg.name)}`]).code === 0) out.login = loginStatus(dir);
  return out;
}

// 새 터미널 창에서 devagent 명령 실행 (GUI용)
function openTerminal(dir, args) {
  const bin = path.join(__dirname, "..", "bin", "devagent.js");
  const node = process.execPath;
  if (process.platform === "win32") {
    const line = [node, bin, ...args].map((a) => `"${a}"`).join(" ");
    spawn("cmd.exe", ["/c", `start "devagent" cmd /k "${line}"`], { cwd: dir, detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  } else if (process.platform === "darwin") {
    const line = `cd ${shq(dir)} && ${[node, bin, ...args].map(shq).join(" ")}`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(line)}`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
  } else {
    const line = `cd ${shq(dir)} && ${[node, bin, ...args].map(shq).join(" ")}; exec bash`;
    spawn("x-terminal-emulator", ["-e", "bash", "-lc", line], { detached: true, stdio: "ignore" }).unref();
  }
}

module.exports = {
  CONFIG_FILE, MODEL_HINTS, PLATFORMS, DEFAULT_CONFIG,
  loadConfig, saveConfig, setKey, validate, init, apply, build, login, loginStatus, repo, start, status, openTerminal, dockerOk, DEFAULT_PROMPT,
};
