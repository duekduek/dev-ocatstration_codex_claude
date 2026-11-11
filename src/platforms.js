// 플랫폼별 프리셋: Docker에 추가할 도구, .gitignore, 빌드 확인 워크플로, 에이전트 안내
const common = {
  gitignore: ["node_modules/", ".env", ".env.*", "!.env.example", "*.log", ".DS_Store"],
};

const PLATFORMS = {
  web: {
    label: "웹 (Node.js: React/Next/Vue 등)",
    docker: [],
    gitignore: ["dist/", "build/", ".next/", "coverage/"],
    ports: [3000, 5173],
    notes: "로컬(컨테이너)에서 `npm run build`/`npm test`로 직접 검증할 수 있다.",
    localCheck: "npm run build --if-present && npm test --if-present",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Build & Test
        run: |
          if [ ! -f package.json ]; then echo "package.json 없음 - 생략"; exit 0; fi
          npm ci || npm install
          npm run build --if-present
          npm test --if-present`,
  },

  "react-native": {
    label: "모바일 (React Native / Expo)",
    docker: [],
    gitignore: [".expo/", "dist/", "web-build/", "ios/Pods/", "android/.gradle/"],
    ports: [8081, 19000, 19006],
    notes: "컨테이너에서 타입체크/린트/테스트로 검증한다. 실기기 확인은 사용자가 Expo Go로 한다.",
    localCheck: "npx tsc --noEmit; npm test --if-present",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Typecheck & Test
        run: |
          if [ ! -f package.json ]; then echo "package.json 없음 - 생략"; exit 0; fi
          npm ci || npm install
          if [ -f tsconfig.json ]; then npx tsc --noEmit; fi
          npm run lint --if-present
          npm test --if-present`,
  },

  python: {
    label: "Python (FastAPI/Django/스크립트 등)",
    docker: ["RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*"],
    gitignore: ["__pycache__/", ".venv/", "*.pyc", ".pytest_cache/"],
    ports: [8000],
    notes: "컨테이너에서 `python3 -m venv .venv`로 가상환경을 만들어 쓰고 pytest로 검증한다.",
    localCheck: "python3 -m pytest",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Install & Test
        run: |
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
          if [ -f pyproject.toml ]; then pip install -e . || true; fi
          pip install pytest
          if ls tests test_*.py */test_*.py >/dev/null 2>&1; then pytest; else echo "테스트 없음 - 생략"; fi`,
  },

  ios: {
    label: "iOS / watchOS (Swift, 빌드는 GitHub Actions macOS)",
    docker: [],
    gitignore: ["*.xcodeproj/", "*.xcworkspace/", "DerivedData/", "xcuserdata/", "build/"],
    ports: [],
    notes: "Linux 컨테이너에서는 Xcode 빌드가 불가능하다. Xcode 프로젝트는 XcodeGen `project.yml`로만 정의하고(.xcodeproj는 커밋하지 않는다), 빌드 검증은 push 후 GitHub Actions(macOS)로 한다. 실기기/시뮬레이터 확인은 사용자가 Mac에서 한다.",
    localCheck: null,
    workflow: `    runs-on: macos-15
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - name: Build (iOS Simulator, no signing)
        run: |
          if [ ! -f project.yml ]; then echo "project.yml 없음 - 생략"; exit 0; fi
          brew install xcodegen
          xcodegen generate
          PROJECT=$(ls -d *.xcodeproj | head -1)
          SCHEME=$(xcodebuild -list -json -project "$PROJECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["schemes"][0])')
          set -o pipefail
          xcodebuild build -project "$PROJECT" -scheme "$SCHEME" \\
            -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO \\
            | tee build.log | grep -E "error:|BUILD (SUCCEEDED|FAILED)"`,
  },

  android: {
    label: "Android (Kotlin/Gradle)",
    docker: ["RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip && rm -rf /var/lib/apt/lists/*"],
    gitignore: [".gradle/", "build/", "local.properties", "*.apk", "*.aab", ".idea/"],
    ports: [],
    notes: "컨테이너에는 JDK만 있고 Android SDK는 없다. 빌드 검증은 push 후 GitHub Actions로 한다(`./gradlew assembleDebug`). Gradle wrapper(gradlew)를 반드시 커밋한다.",
    localCheck: null,
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - uses: android-actions/setup-android@v3
      - name: Build
        run: |
          if [ ! -f gradlew ]; then echo "gradlew 없음 - 생략"; exit 0; fi
          chmod +x gradlew
          ./gradlew assembleDebug testDebugUnitTest`,
  },

  flutter: {
    label: "Flutter (iOS/Android/Web)",
    docker: [
      "RUN apt-get update && apt-get install -y --no-install-recommends unzip xz-utils curl && rm -rf /var/lib/apt/lists/*",
      "USER node",
      "RUN git clone --depth 1 -b stable https://github.com/flutter/flutter.git /home/node/flutter && /home/node/flutter/bin/flutter --version",
      "ENV PATH=/home/node/flutter/bin:$PATH",
      "USER root",
    ],
    gitignore: [".dart_tool/", "build/", ".flutter-plugins", ".flutter-plugins-dependencies", "ios/Pods/"],
    ports: [],
    notes: "컨테이너에서 `flutter analyze`, `flutter test`로 검증한다. iOS 빌드/실기기 확인은 사용자가 Mac에서 한다.",
    localCheck: "flutter analyze && flutter test",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with: { channel: stable }
      - name: Analyze & Test
        run: |
          if [ ! -f pubspec.yaml ]; then echo "pubspec.yaml 없음 - 생략"; exit 0; fi
          flutter pub get
          flutter analyze
          flutter test || [ ! -d test ]`,
  },

  go: {
    label: "Go",
    docker: [
      "RUN curl -fsSL https://go.dev/dl/go1.23.4.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz",
      "ENV PATH=/usr/local/go/bin:/home/node/go/bin:$PATH",
    ],
    gitignore: ["bin/", "*.exe", "coverage.out"],
    ports: [8080],
    notes: "컨테이너에서 `go build ./... && go test ./...`로 검증한다.",
    localCheck: "go build ./... && go test ./...",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "1.23" }
      - name: Build & Test
        run: |
          if [ ! -f go.mod ]; then echo "go.mod 없음 - 생략"; exit 0; fi
          go build ./...
          go test ./...`,
  },

  java: {
    label: "Java / Spring (Gradle 또는 Maven)",
    docker: ["RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven && rm -rf /var/lib/apt/lists/*"],
    gitignore: [".gradle/", "build/", "target/", ".idea/", "*.iml"],
    ports: [8080],
    notes: "컨테이너에서 `./gradlew build` 또는 `mvn -q verify`로 검증한다.",
    localCheck: "if [ -f gradlew ]; then ./gradlew build; else mvn -q verify; fi",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Build & Test
        run: |
          if [ -f gradlew ]; then chmod +x gradlew; ./gradlew build;
          elif [ -f pom.xml ]; then mvn -B verify;
          else echo "빌드 파일 없음 - 생략"; fi`,
  },

  rust: {
    label: "Rust",
    docker: [
      "USER node",
      "RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal",
      "ENV PATH=/home/node/.cargo/bin:$PATH",
      "USER root",
    ],
    gitignore: ["target/"],
    ports: [],
    notes: "컨테이너에서 `cargo build && cargo test`로 검증한다.",
    localCheck: "cargo build && cargo test",
    workflow: `    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Build & Test
        run: |
          if [ ! -f Cargo.toml ]; then echo "Cargo.toml 없음 - 생략"; exit 0; fi
          cargo build
          cargo test`,
  },
};

module.exports = { PLATFORMS, common };
