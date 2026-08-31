# 📚 Daily Test Slack Bot (TOEIC RC & SKCT 인지역량)

Google Apps Script와 **Google Gemini API** (`gemini-3.6-flash`)를 기반으로 매일 아침 Slack 채널에 **TOEIC RC 850+ 실전 문제** 및 **SKCT 인지역량 실전 문제**를 자동 출제하고, Slack Modal을 통해 실시간 채점, 오답 분석, 상세 해설을 제공하는 통합 테스트 봇입니다.

---

## 🌟 핵심 특징

* 🎯 **단일 통합 엔진 (`Code.gs`)**
  * 여러 파일 분리 없이 **단 하나의 스크립트 파일(`Code.gs`)**로 토익과 SKCT를 완벽 지원
  * 전역 변수 충돌 방지 및 유지보수성 극대화
* ⏰ **정기 자동 출제 (Time-driven Triggers)**
  * **매일 오전 07:00 (KST)**: TOEIC RC 실전 평가 (12~14문항)
  * **매일 오전 08:00 (KST)**: SKCT 인지역량 실전 평가 (8문항)
* 🧠 **고성능 AI 모델 계층 (High-Performance Reasoning)**
  * 메인/재시도 모델: `gemini-3.6-flash` (Deep Reasoning, thinkingLevel: high)
  * 일관된 고난도 킬러 문항 퀄리티 유지
* 📱 **세련된 비즈니스 톤 UI & 인터랙티브 모달**
  * 불필요한 AI 설명 문구를 제거한 깔끔한 불릿 리스트형 채널 공지
  * 슬랙 Block Kit 75자 선택지 규격 준수 (단어 잘림 없는 깔끔한 보기)
  * 다중 지문(Part 6, Part 7 단일/이중/삼중) 독립 카드 박스 렌더링
* 🛡️ **엔터프라이즈급 스토리지 & 안정성**
  * **청크 분할 스토리지(`saveChunked_`)**: Google Apps Script의 9KB 스토리지 용량 한계를 극복하여 대용량 삼중 지문/해설도 100% 무손실 저장

---

## 📋 일일 출제 규격

### 1. 📘 TOEIC RC (850~990점 킬러 레벨)
* **Part 5 (5문항)**: 단문 공란 채우기 (문법/어휘 킬러)
* **Part 6 (4문항)**: 지문 1개 + 빈칸 4개 (8번 문장 삽입)
* **Part 7 (요일별 지문 로테이션)**:
  * **월 / 화 (단일 지문 집중)**: 1개 문서 + 3문항 ➡️ **일일 총 12문항**
  * **수 / 목 (이중 연계 지문)**: 2개 연계 문서 + 5문항 ➡️ **일일 총 14문항**
  * **금 / 주말 (삼중 복합 연계 지문)**: 3개 연계 문서 + 5문항 ➡️ **일일 총 14문항**

### 2. 📊 SKCT 인지역량 (핵심 4대 영역)
* **언어이해 (2문항)**: 기업/경제/기술 사설 독해 및 정교한 패러프레이징
* **창의수리 (2문항)**: 속력/거리/시간, 농도, 원가/정가, 일의 양, 확률
* **언어추리 (2문항)**: 삼단논법 전제/결론, 참/거짓 진실게임, 조건 배치
* **수열추리 (2문항)**: 계차수열, 교차연산, 복합 규칙 추론
* ➡️ **일일 총 8문항** (권장 소요시간: 12분)

---

## 📂 파일 구조

```text
daily-test/
├── apps-script/                 # 🤖 구글 앱스 스크립트 백엔드
│   └── Code.gs                  # 전체 통합 봇 엔진 (출제, 파싱, 슬랙 모달, 스토리지)
├── data/                        # 📦 매일 자동 축적되는 문제 데이터 (JSON)
│   ├── manifest.json            # 출제 일자 인덱스 레지스트리
│   ├── toeic/                   # 토익 일자별 문제 JSON
│   │   └── 2026-08-31_TOEIC.json
│   └── skct/                    # SKCT 일자별 문제 JSON
│       └── 2026-08-31_SKCT.json
├── index.html                   # 🌐 CBT 시험 웹페이지 (GitHub Pages)
├── style.css                    # 🎨 모던 반응형 스타일시트
├── app.js                       # ⚡ CBT 인터랙티브 로직 (타이머, OMR, 채점)
├── .gitignore                   # Git 제외 설정
└── README.md                    # 프로젝트 문서 및 설치 가이드
```

---

## 🚀 상세 설치 및 설정 가이드

### 1단계: Slack App 생성 및 권한 설정

1. [Slack API 콘솔](https://api.slack.com/apps)에 접속하여 **Create New App** > **From scratch**를 클릭합니다.
2. **App Name** (예: `Daily Test`)과 봇을 추가할 **Workspace**를 선택합니다.
3. 좌측 메뉴 **Incoming Webhooks**로 이동:
   * **Activate Incoming Webhooks** 스위치를 `On`으로 켭니다.
   * **Add New Webhook to Workspace**를 클릭하여 문제가 발송될 채널을 선택합니다.
   * 생성된 **Webhook URL**을 복사해 둡니다. (`SLACK_WEBHOOK_URL`)
4. 좌측 메뉴 **OAuth & Permissions**로 이동:
   * **Bot Token Scopes**에 `chat:write` 및 `commands` 권한을 추가합니다.
   * 페이지 상단의 **Install to Workspace**를 클릭하여 워크스페이스에 설치합니다.
   * 생성된 **Bot User OAuth Token** (`xoxb-...`)을 복사해 둡니다. (`SLACK_BOT_TOKEN`)

---

### 2단계: Google Gemini API Key 발급

1. [Google AI Studio](https://aistudio.google.com/app/apikey)에 접속하여 구글 계정으로 로그인합니다.
2. **Create API key**를 클릭하여 API 키(`AIzaSy...`)를 발급받고 복사해 둡니다. (`GEMINI_API_KEY`)

---

### 3단계: Google Apps Script 프로젝트 설정

1. [Google Apps Script](https://script.google.com/)에 접속하여 **새 프로젝트**를 생성합니다.
2. 에디터의 기본 파일을 열고, 이 저장소의 [`apps-script/Code.gs`](./apps-script/Code.gs) 전체 내용을 복사하여 붙여넣은 뒤 저장(Ctrl+S)합니다.
3. 좌측 메뉴 **프로젝트 설정 (톱니바퀴 ⚙️)** > **스크립트 속성 (Script Properties)** 섹션에서 **[속성 추가]**를 눌러 아래 3개 값을 등록합니다:

| 속성 (Property) | 값 (Value) | 설명 |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | `AIzaSy...` | 2단계에서 발급받은 Gemini API 키 |
| `SLACK_BOT_TOKEN` | `xoxb-...` | 1단계에서 발급받은 Slack Bot OAuth Token |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/...` | 1단계에서 생성한 Slack Incoming Webhook URL |

---

### 4단계: 웹 앱 (Web App) 배포

1. Apps Script 우측 상단 **[배포] > [새 배포]**를 클릭합니다.
2. 유형 선택 ⚙️ > **[웹 앱 (Web App)]**을 선택합니다.
   * **설명**: `Daily Test Bot Production`
   * **다음 사용자로 실행**: `나 (My account)`
   * **액세스 권한이 있는 사용자**: **`모든 사용자 (Anyone)`** ⚠️ *(반드시 Anyone으로 설정)*
3. **[배포]**를 클릭하고 계정 권한을 승인합니다.
4. 발급된 **웹 앱 URL (`https://script.google.com/macros/s/.../exec`)**을 복사합니다.

---

### 5단계: Slack Interactivity URL 등록

1. Apps Script 에디터(`Code.gs`)에서 상단 함수 목록 중 **`createInteractionSecret`**을 선택하고 **실행(▶️)**을 누릅니다.
2. 하단 실행 로그에 출력되는 보안 파라미터를 확인합니다:
   ```text
   🔑 Request URL에 추가할 값: ?secret=a1b2c3d4e5f6...
   ```
3. [Slack API 콘솔](https://api.slack.com/apps) > 내 앱 > **Interactivity & Shortcuts** 메뉴로 이동합니다.
4. **Interactivity** 스위치를 `On`으로 켭니다.
5. **Request URL**에 `[4단계 웹 앱 URL] + [로그의 ?secret=값]`을 입력하고 **Save Changes**를 클릭합니다.
   * 예: `https://script.google.com/macros/s/AKfycb.../exec?secret=a1b2c3d4e5f6...`

---

### 6단계: 테스트 및 자동 발송 스케줄러 등록

1. **테스트 실행**:
   * `testToeicRun()` 실행 ➡️ 슬랙 채널에 토익 런처 발송 및 모달 풀이 테스트
   * `testSkctRun()` 실행 ➡️ 슬랙 채널에 SKCT 런처 발송 및 모달 풀이 테스트
2. **매일 아침 자동 발송 스케줄러 설치 (1회 실행)**:
   * 함수 목록에서 **`installAllDailyTriggers`**를 선택하고 **실행(▶️)**합니다.
   * 매일 **오전 07:00(토익)** 및 **오전 08:00(SKCT)**에 자동으로 채널에 출제됩니다! 🎉

---

## ⚙️ 설정 커스터마이징 (`Code.gs`)

`Code.gs` 상단의 `APP_CONFIG` 객체를 통해 모델, 타임존, 글자 수 한도 등을 손쉽게 조정할 수 있습니다.

```javascript
const APP_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  
  // Gemini 모델 계층
  PRIMARY_MODEL: 'gemini-3.6-flash',
  FALLBACK_MODEL: 'gemini-3.6-flash',
  
  // API 제어
  MAX_ATTEMPTS: 2,
  MAX_OUTPUT_TOKENS: 30000,
  MIN_API_INTERVAL_MS: 15000,
  RETRY_BASE_DELAY_MS: 10000,
  ...
});
```

---

## ❓ 문제 해결 (Troubleshooting)

* **Q. 슬랙에서 [테스트 시작] 버튼을 눌러도 모달창이 열리지 않아요.**
  * 웹 앱 배포 시 **액세스 권한**이 `모든 사용자 (Anyone)`로 되어 있는지 확인하세요.
  * Slack Interactivity Request URL 끝에 `?secret=...` 쿼리가 정확히 붙어 있는지 확인하세요.
  * 코드를 수정한 후에는 **[배포] > [배포 관리] > [수정(✏️)] > 버전: [새 버전]**으로 갱신 배포해야 수정 사항이 반영됩니다.
* **Q. API 호출 401 오류가 발생해요.**
  * Apps Script 프로젝트 설정의 스크립트 속성에 `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_WEBHOOK_URL`이 등록되어 있는지 확인하세요.
* **Q. 자동 발송 시간을 변경하고 싶어요.**
  * `Code.gs`의 `installAllDailyTriggers()` 함수 내 `atHour(7)`, `atHour(8)` 숫자를 원하는 시간으로 수정한 뒤 다시 한 번 실행해 주시면 됩니다.
