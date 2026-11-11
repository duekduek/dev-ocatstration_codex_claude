// 환경 점검: 필수 도구, Docker 상태, 플랫폼-호스트 호환성
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOST = { win32: "windows", darwin: "mac", linux: "linux" }[process.platform] || process.platform;

function which(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0];
}

const INSTALL = {
  docker: {
    windows: "winget install -e --id Docker.DockerDesktop  (설치 후 재부팅, WSL2 필요: wsl --install)",
    mac: "brew install --cask docker  (또는 docker.com에서 Docker Desktop 설치)",
    linux: "curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER  (재로그인 필요)",
  },
  git: { windows: "winget install -e --id Git.Git", mac: "xcode-select --install", linux: "sudo apt-get install -y git" },
  node: { windows: "winget install -e --id OpenJS.NodeJS.LTS", mac: "brew install node", linux: "https://nodejs.org 또는 nvm으로 Node 18+ 설치" },
};

// 플랫폼별로 이 호스트에서 무엇이 가능한지
function platformAdvice(platform) {
  const a = {
    ios: {
      mac: { level: "ok", msg: "Mac이므로 Xcode로 시뮬레이터/실기기 실행 가능. 컨테이너(Linux)에서는 빌드 불가 → 빌드 검증은 GitHub Actions(macOS), 실행은 이 Mac의 Xcode에서 (xcodegen generate 후 열기)." },
      other: { level: "warn", msg: "iOS는 Mac(Xcode)에서만 빌드/실행 가능. 이 PC에서는 GitHub Actions(macOS)로 빌드 확인만 하고, 앱 실행·시뮬레이터·실기기 테스트는 Mac(맥북)에서 저장소를 clone해 `xcodegen generate` 후 Xcode로 실행해야 함. private 저장소의 macOS Actions는 무료 분량을 10배로 소모함." },
    },
    android: {
      any: { level: "info", msg: "컨테이너에는 Android SDK가 없어 빌드 검증은 GitHub Actions로 함. 에뮬레이터/실기기 실행은 호스트에 Android Studio를 설치해 프로젝트를 열어 실행." },
    },
    flutter: {
      mac: { level: "info", msg: "컨테이너에서 analyze/test 가능. iOS·Android 실행은 이 Mac에 Flutter SDK + Xcode/Android Studio 설치 후 `flutter run`." },
      other: { level: "warn", msg: "컨테이너에서 analyze/test 가능. Android 실행은 호스트에 Flutter + Android Studio 필요. iOS 실행은 Mac에서만 가능." },
    },
    "react-native": {
      any: { level: "info", msg: "컨테이너에서 타입체크/테스트 가능. 실행은 휴대폰의 Expo Go 앱으로 확인(같은 네트워크, 포트 8081 노출됨). iOS 네이티브 빌드는 Mac 또는 EAS Build 필요." },
    },
    web: { any: { level: "ok", msg: "컨테이너에서 빌드/테스트/개발 서버 실행 가능 (포트 3000/5173이 호스트로 노출됨)." } },
    python: { any: { level: "ok", msg: "컨테이너에서 실행/테스트 가능 (포트 8000 노출)." } },
    go: { any: { level: "ok", msg: "컨테이너에서 빌드/테스트 가능 (포트 8080 노출)." } },
    java: { any: { level: "ok", msg: "컨테이너에서 빌드/테스트 가능 (포트 8080 노출)." } },
    rust: { any: { level: "ok", msg: "컨테이너에서 빌드/테스트 가능." } },
  }[platform];
  if (!a) return null;
  return a.any || (HOST === "mac" ? a.mac : a.other);
}

function doctor(dir) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix: ok ? undefined : fix });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 18, `v${process.versions.node}`, INSTALL.node[HOST]);
  const git = which("git");
  add("git", !!git, git || "없음", INSTALL.git[HOST]);
  const docker = which("docker");
  add("docker 설치", !!docker, docker || "없음", INSTALL.docker[HOST]);
  if (docker) {
    const running = which("docker", ["info", "--format", "{{.ServerVersion}}"]);
    add("docker 실행 중", !!running, running ? `engine ${running}` : "꺼짐",
      HOST === "linux" ? "sudo systemctl start docker" : "Docker Desktop 앱을 실행하고 엔진이 켜질 때까지 대기");
    const compose = which("docker", ["compose", "version"]);
    add("docker compose", !!compose, compose || "없음", "Docker Desktop 최신 버전 설치 (compose v2 포함)");
  }
  const hostCodexAuth = fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
  checks.push({ name: "호스트 Codex 로그인 정보", ok: true, detail: hostCodexAuth ? "있음 (login 시 컨테이너로 복사)" : "없음 (login 시 기기 코드 로그인 — ChatGPT 보안 설정에서 기기 코드 로그인 허용 필요)" });

  let cfg = null;
  try { cfg = require("./core").loadConfig(dir); } catch {}
  const advice = cfg ? platformAdvice(cfg.platform) : null;
  return { host: HOST, os: `${os.type()} ${os.release()}`, dir, project: cfg ? { name: cfg.name, platform: cfg.platform } : null, checks, platformAdvice: advice, ready: checks.every((c) => c.ok) };
}

module.exports = { doctor, platformAdvice, HOST };
