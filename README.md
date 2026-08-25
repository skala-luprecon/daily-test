# 📚 Daily Test Slack Bot (TOEIC RC & SKCT CT)

Google Apps Script와 **Google Gemini API (`gemini-3.6-flash`)**를 활용하여 매일 아침 Slack 채널에 자동으로 **TOEIC RC** 및 **SKCT-style CT(인지역량)** 문제를 출제하고, Slack Modal 창을 통해 답안 제출, 실시간 채점, 오답 분석 및 상세 해설을 제공하는 자동화 테스트 봇입니다.

---

## 🌟 주요 기능

* ⏰ **자동 정기 출제 (Time-driven Trigger)**
  * **오전 07:00 (KST)**: TOEIC RC Daily Test (Part 5, 6, 7 총 13문항)
  * **오전 08:00 (KST)**: SKCT CT Daily Test (언어논리, 자료해석, 수리응용, 논리추리 총 8문항)
* 🧠 **최신 Gemini 모델 기반 고품질 문항 생성**
  * `gemini-3.6-flash` (장애 시 `gemini-3.5-flash-lite` 자동 Fallback)
  * 최근 출제된 지문 및 테마를 기억(`CT_RECENT_THEMES`)하여 중복 방지
* 📱 **Slack Block Kit 대화형 모달 (Interactive Modal UI)**
  * 슬랙 채널을 도배하지 않고 깔끔한 팝업 모달창에서 4지선다 라디오 버튼으로 문제 풀이
  * 제출 즉시 **총점, 정답률, 영역별 점수** 확인
  * **전체 해설 보기** 및 **틀린 문제만 보기** 기능 제공 (상세 해설, 보기별 오답 분석, 핵심 어휘)
* 🛡️ **안정적인 엔터프라이즈급 아키텍처**
  * API Rate Limit 슬롯 제어 및 지수 백오프(Exponential Backoff) 재시도 로직
  * 스크립트 락(LockService) 및 웹훅 요청 보안 토큰(`SLACK_INTERACTION_SECRET`) 검증

---

## 📂 파일 구성

* [`Code.gs`](./Code.gs): TOEIC RC Daily Bot 메인 로직, Slack API/Webhook 공통 유틸리티, Interaction 라우팅
* [`CT.gs`](./CT.gs): SKCT-style CT(인지역량) 문제 생성, 데이터 스토리지, Modal 렌더링 및 채점 핸들러

---

## 🚀 상세 설치 및 설정 매뉴얼

### 1단계: Slack App 생성 및 권한 설정

1. [Slack API 콘솔](https://api.slack.com/apps)에 접속하여 **Create New App** > **From scratch**를 클릭합니다.
2. **App Name** (예: `Daily Test Bot`)과 봇을 추가할 **Workspace**를 선택하고 생성합니다.
3. 좌측 메뉴 **Incoming Webhooks**로 이동:
   * **Activate Incoming Webhooks**를 `On`으로 활성화합니다.
   * 하단의 **Add New Webhook to Workspace**를 클릭하여 문제가 발송될 채널을 선택합니다.
   * 생성된 **Webhook URL**을 복사해 둡니다. (이후 `SLACK_WEBHOOK_URL`로 사용)
4. 좌측 메뉴 **OAuth & Permissions**로 이동:
   * **Scopes** > **Bot Token Scopes**에 아래 권한을 추가합니다:
     * `chat:write` (채널에 메시지 전송)
     * `commands` (상호작용 처리)
   * 페이지 상단의 **Install to Workspace**를 클릭하여 워크스페이스에 앱을 설치합니다.
   * 설치 후 표시되는 **Bot User OAuth Token** (`xoxb-...`로 시작)을 복사해 둡니다. (이후 `SLACK_BOT_TOKEN`으로 사용)

---

### 2단계: Google Gemini API Key 발급

1. [Google AI Studio](https://aistudio.google.com/)에 접속하여 구글 계정으로 로그인합니다.
2. **Get API key** > **Create API key**를 클릭하여 API 키를 발급받고 복사해 둡니다. (이후 `GEMINI_API_KEY`로 사용)

---

### 3단계: Google Apps Script 프로젝트 생성 및 코드 작성

1. [Google Apps Script](https://script.google.com/)에 접속하여 **새 프로젝트**를 생성합니다.
2. 프로젝트 상단의 이름을 `Daily Test Bot`으로 변경합니다.
3. 기본 생성된 `코드.gs` 파일명을 `Code.gs`로 변경하고, 저장소의 [`Code.gs`](./Code.gs) 내용을 복사하여 붙여넣습니다.
4. 좌측 파일 목록의 **+ (파일 추가)** > **스크립트**를 클릭하고 파일명을 `CT.gs`로 입력합니다.
5. 저장소의 [`CT.gs`](./CT.gs) 내용을 복사하여 붙여넣습니다.
6. 상단의 💾 **저장** 아이콘을 클릭합니다.

---

### 4단계: 스크립트 속성 (Script Properties) 환경 변수 등록

1. Apps Script 좌측 메뉴에서 **프로젝트 설정 (톱니바퀴 아이콘)**을 클릭합니다.
2. 페이지 하단의 **스크립트 속성 (Script Properties)** 섹션에서 **속성 추가**를 클릭하여 아래 3개 값을 등록합니다:

| 속성 (Property) | 값 (Value) | 설명 |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | `AIzaSy...` | 2단계에서 발급받은 Gemini API 키 |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/services/...` | 1단계에서 복사한 Slack Webhook URL |
| `SLACK_BOT_TOKEN` | `xoxb-...` | 1단계에서 복사한 Slack Bot User OAuth Token |

3. **스크립트 속성 저장**을 클릭합니다.

---

### 5단계: 웹 앱 (Web App) 배포

Slack 모달의 버튼 클릭 및 답안 제출 이벤트를 수신하기 위해 Apps Script를 웹 앱으로 배포해야 합니다.

1. Apps Script 우측 상단의 **배포** > **새 배포**를 클릭합니다.
2. 좌측 톱니바퀴 아이콘 > **웹 앱(Web App)**을 선택합니다.
3. 설정을 다음과 같이 지정합니다:
   * **설명**: `Daily Test Bot v1.0`
   * **다음 사용자로 실행 (Execute as)**: `나(My account)`
   * **액세스 권한이 있는 사용자 (Who has access)**: `모든 사용자(Anyone)` ⚠️ *(반드시 Anyone으로 설정해야 Slack 서버의 요청을 수신할 수 있습니다)*
4. **배포**를 클릭하고, 최초 1회 구글 계정 권한 승인(Advanced > Go to project > Allow)을 완료합니다.
5. 배포 완료 창에 표시되는 **웹 앱 URL (Web App URL)**을 복사합니다.
   * 형식: `https://script.google.com/macros/s/AKfycb.../exec`

---

### 6단계: 보안 시크릿 발급 및 Slack Interactivity URL 등록

Slack과 Apps Script 간의 위조 요청을 방지하기 위해 보안 시크릿을 등록합니다.

1. Apps Script 에디터(`Code.gs`)로 돌아와 상단 함수 선택 드롭다운에서 **`createInteractionSecret`**을 선택하고 **실행**을 누릅니다.
2. 하단 **실행 로그**를 확인하면 다음과 같은 형식으로 시크릿이 출력됩니다:
   ```text
   Request URL 뒤에 붙일 값: ?secret=a1b2c3d4e5f6...
   ```
3. [Slack API 콘솔](https://api.slack.com/apps) > 내 앱 > 좌측 **Interactivity & Shortcuts** 메뉴로 이동합니다.
4. **Interactivity** 스위치를 `On`으로 켭니다.
5. **Request URL** 입력란에 **`[5단계 웹 앱 URL] + [로그에 출력된 ?secret=값]`**을 입력합니다.
   * 예시:
     `https://script.google.com/macros/s/AKfycb.../exec?secret=a1b2c3d4e5f6...`
6. 우측 하단의 **Save Changes**를 클릭합니다.

---

### 7단계: 연결 테스트 및 매일 자동 발송 트리거 설치

1. **Slack Webhook 연결 테스트**:
   * 함수 선택창에서 `testSlackWebhook`을 선택하고 **실행**합니다.
   * Slack 채널에 `TOEIC Daily Bot 연결 성공 ✅` 메시지가 오는지 확인합니다.
2. **문제 생성 및 모달 테스트**:
   * `testFullRun()` 실행 ➡️ 채널에 TOEIC 런처 메시지가 오고, **'Daily RC 풀기'** 버튼을 눌러 모달창이 정상 작동하는지 확인합니다.
   * `testCtFullRun()` 실행 ➡️ 채널에 CT 런처 메시지가 오고, **'Daily CT 풀기'** 버튼을 눌러 모달창이 정상 작동하는지 확인합니다.
3. **매일 아침 자동 발송 트리거 등록**:
   * 함수 선택창에서 **`installAllDailyTriggers`**를 선택하고 **실행**합니다.
   * 이제 매일 **오전 7시(TOEIC RC)**와 **오전 8시(CT)**에 새로운 문제가 자동으로 생성되어 Slack 채널에 출제됩니다! 🎉

---

## ⚙️ 설정 커스터마이징

`Code.gs` 상단의 `CONFIG` 및 `CT.gs` 상단의 `CT_CONFIG` 객체를 수정하여 봇의 동작을 원하는 대로 조정할 수 있습니다.

```javascript
// CT.gs 설정 예시
const CT_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  MODEL: 'gemini-3.6-flash',          // 메인 생성 모델
  FALLBACK_MODEL: 'gemini-3.5-flash-lite', // 장애 시 대체 모델
  TARGET_DIFFICULTY: 'SKCT-style intermediate to advanced',
  QUESTION_COUNT: 8,                  // 일일 출제 문항 수
  MAX_ATTEMPTS: 2,                    // 생성 재시도 횟수
  ...
});
```

---

## ❓ 자주 묻는 질문 (FAQ & Troubleshooting)

**Q. Slack에서 'Daily 풀기' 버튼을 눌렀는데 반응이 없거나 오류 알림이 뜹니다.**
* Apps Script의 웹 앱 배포 시 **액세스 권한(Who has access)**이 `모든 사용자(Anyone)`로 설정되어 있는지 확인하세요.
* Slack 콘솔의 **Interactivity Request URL**에 `?secret=...` 쿼리 파라미터가 정확히 포함되어 있는지 확인하세요.
* 코드를 수정한 경우 **배포 관리** > **수정(연필 아이콘)** > **버전: 새 버전**으로 선택 후 다시 배포해야 변경 사항이 반영됩니다.

**Q. 매일 아침 문제가 발송되지 않아요.**
* Apps Script 좌측의 **트리거 (시계 아이콘)** 메뉴로 이동하여 `sendDailyToeicTest` 및 `sendDailyCtTest` 트리거가 정상 등록되어 있는지 확인하세요.
* `installAllDailyTriggers()` 함수를 다시 실행하면 기존 트리거를 초기화하고 안전하게 재설치합니다.

**Q. Gemini API 비용이 발생하나요?**
* Google AI Studio의 무료 티어(Free Tier) 범위(분당 15회, 일일 수백 회 요청) 내에서 작동하므로 비용이 발생하지 않습니다.
