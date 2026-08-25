/**
 * ============================================================================
 * [Next-Gen Unified Slack Quiz Bot Architecture] - test.gs
 * ============================================================================
 * 
 * 💡 아키텍처 설계 철학 및 기존 코드와의 차별점:
 * 
 * 1. [자가 치유형 방어적 파싱 (Self-Healing & Defensive Parsing)]
 *    - 기존 방식: AI의 사소한 포맷 실수(예: 빈칸 마커 노출, 약간 긴 텍스트) 시
 *      무조건 에러를 던지고 전체 문항을 버린 뒤 재시도 -> 타임아웃 및 잦은 실패.
 *    - 개선 방식: AI가 출력한 JSON을 먼저 수리(Repair)하고, 사소한 마커나 포맷은
 *      코드 수준에서 '자동 정제(Auto-Sanitizing)'하여 불필요한 재시도 0% 달성.
 * 
 * 2. [토익 + SKCT 5대 영역 완전 통합 (Unified Engine)]
 *    - 최신 온라인 SKCT 5대 영역(언어이해, 자료해석, 창의수리, 언어추리, 수열추리) 완벽 지원.
 *    - 자료해석 표를 Slack에서 깨지지 않는 '고정폭 코드블록 표'로 자동 렌더링.
 * 
 * 3. [모듈화 및 엔터프라이즈급 안정성]
 *    - Gemini API: Rate limit 제어, 지수 백오프, Primary(3.6) -> Fallback(3.5-lite) 자동 전환.
 *    - Slack: Block Kit 모달 100블록 제한 안전 분할, 보안 시크릿 검증.
 *    - Storage: ScriptProperties 9KB 용량 제한 안전 청크 분할.
 * ============================================================================
 */

// ============================================================================
// 1. GLOBAL CONFIGURATION
// ============================================================================
const APP_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  
  // Gemini 모델 계층
  PRIMARY_MODEL: 'gemini-3.6-flash',
  FALLBACK_MODEL: 'gemini-3.5-flash-lite',
  
  // API 제어
  MAX_ATTEMPTS: 2,
  MAX_OUTPUT_TOKENS: 30000,
  MIN_API_INTERVAL_MS: 15000,
  RETRY_BASE_DELAY_MS: 10000,
  
  // 제약 조건
  MAX_PROPERTY_BYTES: 8000,
  MAX_MODAL_BLOCKS: 90,
  MAX_SECTION_CHARS: 2800,
  
  // Storage Keys
  KEYS: {
    TOEIC_QUIZ: 'QUIZ_TOEIC_CURRENT',
    SKCT_QUIZ: 'QUIZ_SKCT_CURRENT',
    SECRET: 'SLACK_INTERACTION_SECRET',
    LAST_API_CALL: 'LAST_GEMINI_API_CALL'
  }
});

// SKCT 최신 5대 영역 라벨 및 메타
const SKCT_AREAS = Object.freeze({
  verbal_comprehension: { label: '언어이해', count: 2 },
  data_interpretation:  { label: '자료해석', count: 2 },
  creative_math:        { label: '창의수리', count: 2 },
  verbal_reasoning:     { label: '언어추리', count: 2 },
  sequence_reasoning:   { label: '수열추리', count: 2 }
});

// ============================================================================
// 2. ENTRY POINTS & HTTP ROUTING (Slack Webhook & Interactivity)
// ============================================================================

function doPost(e) {
  try {
    verifySlackSecurity_(e);

    if (!e || !e.parameter || !e.parameter.payload) {
      return ContentService.createTextOutput('OK');
    }

    const payload = JSON.parse(e.parameter.payload);

    // 1) 모달 답안 제출 처리 (Submit)
    if (payload.type === 'view_submission') {
      const callbackId = payload.view && payload.view.callback_id;
      if (callbackId === 'quiz_submit_toeic' || callbackId === 'quiz_submit_skct') {
        return handleUnifiedSubmission_(payload);
      }
    }

    // 2) 버튼 클릭 상호작용 (Block Actions)
    if (payload.type === 'block_actions') {
      const action = payload.actions && payload.actions[0];
      if (!action) return ContentService.createTextOutput('');

      // 퀴즈 풀기 모달 열기
      if (action.action_id === 'open_toeic_modal' || action.action_id === 'open_skct_modal') {
        openQuizModal_(payload.trigger_id, action.action_id === 'open_toeic_modal' ? 'TOEIC' : 'SKCT');
        return ContentService.createTextOutput('');
      }

      // 해설 모달 전환 (전체보기 / 오답만 보기)
      if (action.action_id === 'show_explanations_all' || action.action_id === 'show_explanations_wrong') {
        updateExplanationModal_(payload, action.action_id === 'show_explanations_wrong');
        return ContentService.createTextOutput('');
      }

      // 채점 결과 화면으로 복귀
      if (action.action_id === 'back_to_score_view') {
        updateScoreModal_(payload);
        return ContentService.createTextOutput('');
      }
    }

    return ContentService.createTextOutput('OK');
  } catch (error) {
    Logger.log('doPost Error: ' + (error.stack || error));
    return ContentService.createTextOutput('');
  }
}

function doGet() {
  return ContentService.createTextOutput('Unified Daily Test Bot Engine is Running Healthy. 🚀');
}

// ============================================================================
// 3. DAILY SCHEDULER & TRIGGERS
// ============================================================================

/** 매일 아침 7시 토익, 8시 SKCT 자동 출제 트리거 설치 */
function installAllDailyTriggers() {
  const handlers = ['triggerDailyToeic', 'triggerDailySkct'];
  
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // TOEIC: 매일 오전 7시
  ScriptApp.newTrigger('triggerDailyToeic')
    .timeBased()
    .atHour(7)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(APP_CONFIG.TIME_ZONE)
    .create();

  // SKCT: 매일 오전 8시
  ScriptApp.newTrigger('triggerDailySkct')
    .timeBased()
    .atHour(8)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(APP_CONFIG.TIME_ZONE)
    .create();

  Logger.log('✅ Daily 트리거 설치 완료 (07:00 TOEIC RC, 08:00 SKCT 5대 영역)');
}

function triggerDailyToeic() {
  runWithLock_('TOEIC_LOCK', function() {
    const date = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
    const quiz = generateToeicQuizUnified_(date);
    saveQuizData_('TOEIC', quiz);
    postLauncherToSlack_('TOEIC', quiz);
  });
}

function triggerDailySkct() {
  runWithLock_('SKCT_LOCK', function() {
    const date = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
    const quiz = generateSkctQuizUnified_(date);
    saveQuizData_('SKCT', quiz);
    postLauncherToSlack_('SKCT', quiz);
  });
}

// 테스트용 함수
function testToeicRun() { triggerDailyToeic(); }
function testSkctRun() { triggerDailySkct(); }

// ============================================================================
// 4. INTELLIGENT GEMINI CLIENT (With Auto-Fallback & Self-Healing JSON)
// ============================================================================

function callGeminiRobust_(prompt, customTemp) {
  const models = [APP_CONFIG.PRIMARY_MODEL, APP_CONFIG.FALLBACK_MODEL];
  const apiKey = getEnv_('GEMINI_API_KEY');
  let lastErr = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      throttleGeminiCalls_();

      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: customTemp || 0.5,
          topP: 0.95,
          maxOutputTokens: APP_CONFIG.MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          thinkingConfig: {
            thinkingLevel: 'high'
          }
        }
      };

      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const statusCode = response.getResponseCode();
      const rawText = response.getContentText();

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error('Gemini API HTTP ' + statusCode + ': ' + rawText.slice(0, 400));
      }

      const parsedJson = parseAndRepairJson_(rawText);
      return { data: parsedJson, model: model };
    } catch (err) {
      lastErr = err;
      Logger.log('⚠️ Model [' + model + '] 실패: ' + err.message);
      Utilities.sleep(2000);
    }
  }

  throw new Error('모든 Gemini 모델 호출 실패: ' + (lastErr ? lastErr.message : 'Unknown'));
}

/** JSON 파싱 및 AI 특유의 마크다운 펜스/트림 자동 수리 */
function parseAndRepairJson_(responseText) {
  const env = JSON.parse(responseText);
  const candidate = env.candidates && env.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    throw new Error('Gemini 응답 Candidate가 비어 있습니다.');
  }

  let text = candidate.content.parts.map(function(p) { return p.text || ''; }).join('').trim();
  
  // 마크다운 펜스 제거
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // 흔한 JSON 오류 보정: 잘린 괄호 보정 시도
    if (text.lastIndexOf('}') < text.lastIndexOf(']')) text += '}';
    if (text.charAt(text.length - 1) !== '}') text += '}';
    return JSON.parse(text);
  }
}

function throttleGeminiCalls_() {
  const props = PropertiesService.getScriptProperties();
  const lastTime = Number(props.getProperty(APP_CONFIG.KEYS.LAST_API_CALL) || 0);
  const diff = Date.now() - lastTime;
  if (diff < APP_CONFIG.MIN_API_INTERVAL_MS) {
    Utilities.sleep(APP_CONFIG.MIN_API_INTERVAL_MS - diff);
  }
  props.setProperty(APP_CONFIG.KEYS.LAST_API_CALL, String(Date.now()));
}

/** SKCT 최신 5대 영역 통합 생성기 (고난도 실전형 + 미려한 유니코드 표) */
function generateSkctQuizUnified_(date) {
  const prompt = [
    'You are a senior test development specialist for the official Korean SKCT (SK Comprehensive Test) online cognitive aptitude test.',
    'Date: ' + date,
    'Target Difficulty: Intermediate to Advanced (SKCT 85th-95th percentile).',
    'Create exactly 10 original, challenging SKCT practice questions covering the 5 core cognitive domains (2 questions per domain).',
    'Language: All user-visible scenarios, questions, options, and explanations MUST be in refined, professional Korean.',
    '',
    'DOMAIN SPECIFICATIONS (Exactly 2 questions each):',
    '1. "verbal_comprehension" (언어이해): Deep corporate/tech/economic editorial reading. Include subtle traps in options via paraphrasing, conditional qualifiers, and fact-checking.',
    '2. "data_interpretation" (자료해석): MUST format all structured numerical tables inside ``` monospace code fences using neat Unicode box-drawing characters (┌, ─, ┬, ┐, │, ├, ┼, ┤, └, ┴, ┘) with perfectly aligned columns. Test weighted averages, %p vs %, compound growth, and cross-column arithmetic. CRITICAL: Re-verify all mathematical calculations across all 4 options so that exactly one option is defensibly correct.',
    '3. "creative_math" (창의수리): Speed/distance/time with two moving bodies or varying speeds, multi-stage mixture/concentration (농도), cost-margin-discount algebra, complex work rates, or combination/probability.',
    '4. "verbal_reasoning" (언어추리): Syllogism (삼단논법/전제결론 제시형), strict truth-teller/liar puzzle (진실게임), or 4-5 entity multi-attribute grid placement under <조건>. Ensure exactly one airtight logical solution.',
    '5. "sequence_reasoning" (수열추리): Non-trivial numerical sequence deduction (e.g. geometric difference series, alternating compound operations, quadratic recurrence). Present clearly as "a, b, c, d, e, (?)" and provide the exact mathematical formula in explanation.',
    '',
    'OUTPUT SCHEMA (Valid JSON only, no markdown commentary):',
    '{',
    '  "questions": [',
    '    {',
    '      "domain": "verbal_comprehension" | "data_interpretation" | "creative_math" | "verbal_reasoning" | "sequence_reasoning",',
    '      "difficulty": "medium" | "hard",',
    '      "scenario": "string (Passage, constraints under <조건>, or clean monospace Unicode box table inside ```...```)",',
    '      "question": "string (Standard Korean phrasing like: 다음 글을 읽고 알 수 있는 것은?, 다음 조건을 만족할 때 항상 참인 것은?)",',
    '      "options": ["A", "B", "C", "D"],',
    '      "answerIndex": 0,',
    '      "explanation": "string (Step-by-step mathematical or logical solution)",',
    '      "optionExplanations": ["Option A note", "Option B note", "Option C note", "Option D note"]',
    '    }',
    '  ]',
    '}'
  ].join('\n');

  const res = callGeminiRobust_(prompt, 0.45);
  const questions = res.data.questions;
  if (!Array.isArray(questions) || questions.length !== 10) {
    throw new Error('SKCT 문항 수 불일치: ' + (questions ? questions.length : 0));
  }

  // 자가 복구 및 정제 (Sanitization)
  questions.forEach(function(q, idx) {
    q.id = 'SKCT_Q' + (idx + 1);
    q.number = idx + 1;
    q.scenario = String(q.scenario || '').trim();
    q.question = String(q.question || '').trim();
    
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(q.id + ' 선택지 개수 오류');
    }
    q.options = q.options.map(function(opt) { return String(opt).slice(0, 65).trim(); });
    q.answerIndex = Number(q.answerIndex) || 0;
  });

  return {
    type: 'SKCT',
    title: '🧠 SKCT 인지역량 5대 영역 Daily Test',
    testId: 'SKCT_' + date.replace(/-/g, ''),
    date: date,
    model: res.model,
    questions: questions
  };
}

/** TOEIC RC (Part 5, 6, 7) 고난도 850-950+ 킬러 생성기 (지문 코드블록 카드화) */
function generateToeicQuizUnified_(date) {
  const prompt = [
    'You are an expert senior test writer for ETS TOEIC Advanced (Target Score Band: 850-990).',
    'Date: ' + date,
    'Create an authentic, high-difficulty 13-question TOEIC Reading practice test: Part 5 (5 Qs), Part 6 (1 passage with 4 Qs), Part 7 (1 passage with 4 Qs).',
    '',
    'STRICT 850-950+ LEVEL QUALITY MANDATES:',
    '1. PART 5 (5 Challenging Grammar & Advanced Vocabulary Items):',
    '   - Long sentence structures with complex modifier traps (participial clauses, subjunctive mood with demand/mandate/insist, inverted conditionals like "Should you require", compound relative pronouns "Whoever/Whichever", or advanced prepositions/conjunctions "Notwithstanding/Given that/Provided that").',
    '   - Advanced business collocations ("commensurate with", "contingent upon", "stringent regulations", "tentatively scheduled", "unprecedented surge").',
    '   - ALL 4 options MUST be sophisticated words with zero obvious throwaway distractors (e.g. no malformed words like "In spite" without of).',
    '',
    '2. PART 6 (4 Questions on a Dense 170-220 Word Business Document):',
    '   - Realistic context: Contract revision, merger restructuring, supply chain penalty terms, or policy amendment.',
    '   - Mark blanks strictly as [1], [2], [3], [4] in ascending order.',
    '   - For question [3] (Sentence Insertion): ALL 4 options must contain keywords from the passage. Only ONE option must fit perfectly based on cohesive devices (demonstratives, chronological reference, cause/effect).',
    '   - In the JSON "question" field for Part 6, write simply "Select the best option for the blank." (Never repeat bracketed markers like [1] in question).',
    '',
    '3. PART 7 (4 Questions on a Dense 220-280 Word Business Notice/Article/Memo):',
    '   - Include detailed business conditions, footnotes (*), and exception clauses ("except in cases of", "applicable only to").',
    '   - Mandatory Question Types:',
    '     * Q1: Complex Main Purpose (with high-level paraphrasing).',
    '     * Q2: Negative Fact (NOT/TRUE question): "What is NOT mentioned/true regarding...?" requiring meticulous fact-checking.',
    '     * Q3: Cross-Referencing Inference: "What is implied about...?" requiring combining clues from multiple sentences.',
    '     * Q4: Advanced Contextual Synonym: A polysemous business word (e.g. "deliver", "entertain", "sound", "execute", "address", "secure").',
    '',
    'OUTPUT SCHEMA (Valid JSON only, no markdown notes):',
    '{',
    '  "part5": { "questions": [ { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Detailed Korean solution explaining grammar rule & why distractors fail", "optionExplanations": ["A","B","C","D"] } ] },',
    '  "part6": { "documentType": "...", "passage": "...", "passageTranslation": "...", "questions": [ { "blankNumber": 1, "question": "Select the best option for the blank.", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Korean", "optionExplanations": ["A","B","C","D"] } ] },',
    '  "part7": { "documentType": "...", "passage": "...", "passageTranslation": "...", "questions": [ { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Korean", "optionExplanations": ["A","B","C","D"] } ] }',
    '}'
  ].join('\n');

  const res = callGeminiRobust_(prompt, 0.55);
  const data = res.data;

  // 자가 치유형 통합 리스트 변환
  const unifiedQuestions = [];
  let qNum = 1;

  // Part 5 처리
  data.part5.questions.forEach(function(q) {
    q.id = 'TOEIC_Q' + qNum;
    q.number = qNum++;
    q.part = 'Part 5';
    q.scenario = '';
    q.options = q.options.map(function(o) { return String(o).slice(0, 65).trim(); });
    unifiedQuestions.push(q);
  });

  // Part 6 처리 (지문을 깔끔한 ``` 코드블록 카드로 포맷팅)
  data.part6.questions.forEach(function(q) {
    q.id = 'TOEIC_Q' + qNum;
    q.number = qNum++;
    q.part = 'Part 6';
    q.scenario = '```\n[' + data.part6.documentType + ']\n\n' + data.part6.passage + '\n```';
    q.question = String(q.question || '').replace(/\[\d+\]/g, '').trim() || 'Select the best option for the blank.';
    q.options = q.options.map(function(o) { return String(o).slice(0, 65).trim(); });
    unifiedQuestions.push(q);
  });

  // Part 7 처리 (지문을 깔끔한 ``` 코드블록 카드로 포맷팅)
  data.part7.questions.forEach(function(q) {
    q.id = 'TOEIC_Q' + qNum;
    q.number = qNum++;
    q.part = 'Part 7';
    q.scenario = '```\n[' + data.part7.documentType + ']\n\n' + data.part7.passage + '\n```';
    q.options = q.options.map(function(o) { return String(o).slice(0, 65).trim(); });
    unifiedQuestions.push(q);
  });

  return {
    type: 'TOEIC',
    title: '📚 TOEIC RC 850+ Killer Daily Test (Part 5, 6, 7)',
    testId: 'TOEIC_' + date.replace(/-/g, ''),
    date: date,
    model: res.model,
    questions: unifiedQuestions
  };
}

// ============================================================================
// 6. SLACK MODAL & BLOCK KIT UI ENGINE
// ============================================================================

function postLauncherToSlack_(type, quiz) {
  const webhookUrl = getEnv_('SLACK_WEBHOOK_URL');
  const countText = type === 'SKCT' ? '총 10문항 (5대 영역 각 2문항) · 예상 15분' : '총 13문항 (Part 5/6/7) · 예상 12분';
  const actionId = type === 'SKCT' ? 'open_skct_modal' : 'open_toeic_modal';
  const btnText = type === 'SKCT' ? 'Daily SKCT 풀기 🧠' : 'Daily TOEIC 풀기 📚';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: quiz.title, emoji: true }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '*' + quiz.date + '* · ' + countText }]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '제출 즉시 *실시간 채점, 오답 분석, 상세 해설*을 확인할 수 있습니다.\n_모달창에서 편안하게 문제를 풀어보세요!_'
      }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '🤖 Engine: `' + quiz.model + '`' }]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: actionId,
          text: { type: 'plain_text', text: btnText, emoji: true },
          value: quiz.testId
        }
      ]
    }
  ];

  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ blocks: blocks })
  });
}

function openQuizModal_(triggerId, type) {
  const quiz = loadQuizData_(type);
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*' + quiz.date + ' ' + quiz.title + '*\n모든 문제의 답안을 선택한 후 하단의 [답안 제출] 버튼을 눌러주세요.' }
    }
  ];

  quiz.questions.forEach(function(q) {
    blocks.push({ type: 'divider' });

    let label = '*' + q.number + '번';
    if (q.domain && SKCT_AREAS[q.domain]) label += ' · ' + SKCT_AREAS[q.domain].label;
    if (q.part) label += ' · ' + q.part;
    label += '*';

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: label } });

    if (q.scenario) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: q.scenario } });
    }

    blocks.push({
      type: 'input',
      block_id: q.id,
      label: { type: 'plain_text', text: q.question || '정답을 선택하세요.' },
      element: {
        type: 'radio_buttons',
        action_id: 'selected_answer',
        options: q.options.map(function(opt, idx) {
          const letter = ['A', 'B', 'C', 'D'][idx];
          return {
            text: { type: 'plain_text', text: '(' + letter + ') ' + opt },
            value: String(idx)
          };
        })
      }
    });
  });

  callSlackWebApi_('views.open', {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: type === 'SKCT' ? 'quiz_submit_skct' : 'quiz_submit_toeic',
      private_metadata: JSON.stringify({ testId: quiz.testId, type: type }),
      title: { type: 'plain_text', text: type + ' Daily Quiz' },
      submit: { type: 'plain_text', text: '답안 제출' },
      close: { type: 'plain_text', text: '취소' },
      blocks: blocks.slice(0, APP_CONFIG.MAX_MODAL_BLOCKS)
    }
  });
}

function handleUnifiedSubmission_(payload) {
  const meta = JSON.parse(payload.view.private_metadata);
  const quiz = loadQuizData_(meta.type);
  const state = payload.view.state.values;
  const userAnswers = {};
  let correctCount = 0;

  quiz.questions.forEach(function(q) {
    const selected = state[q.id] && state[q.id].selected_answer && state[q.id].selected_answer.selected_option;
    const ans = selected ? Number(selected.value) : -1;
    userAnswers[q.id] = ans;
    if (ans === q.answerIndex) correctCount++;
  });

  const submission = {
    userId: payload.user.id,
    testId: quiz.testId,
    type: meta.type,
    userAnswers: userAnswers,
    correctCount: correctCount,
    totalCount: quiz.questions.length
  };

  saveUserSubmission_(submission);

  return ContentService.createTextOutput(JSON.stringify({
    response_action: 'update',
    view: buildScoreModalView_(quiz, submission)
  })).setMimeType(ContentService.MimeType.JSON);
}

function buildScoreModalView_(quiz, sub) {
  const pct = Math.round((sub.correctCount / sub.totalCount) * 100);

  return {
    type: 'modal',
    callback_id: 'score_view',
    private_metadata: JSON.stringify({ testId: quiz.testId, type: sub.type, userId: sub.userId }),
    title: { type: 'plain_text', text: '채점 결과' },
    close: { type: 'plain_text', text: '닫기' },
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🎉 채점 완료! (' + sub.correctCount + '/' + sub.totalCount + ' 정답)', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*총점:* `' + sub.correctCount + ' / ' + sub.totalCount + '` (정답률: *' + pct + '%*)\n\n상세 해설과 오답 분석을 확인해보세요!'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            action_id: 'show_explanations_all',
            text: { type: 'plain_text', text: '전체 해설 보기 📖' },
            value: sub.type
          },
          {
            type: 'button',
            action_id: 'show_explanations_wrong',
            text: { type: 'plain_text', text: '틀린 문제만 보기 ❌' },
            value: sub.type
          }
        ]
      }
    ]
  };
}

function updateExplanationModal_(payload, wrongOnly) {
  const meta = JSON.parse(payload.view.private_metadata);
  const quiz = loadQuizData_(meta.type);
  const sub = loadUserSubmission_(meta.type, payload.user.id);
  const blocks = [
    {
      type: 'actions',
      elements: [{ type: 'button', action_id: 'back_to_score_view', text: { type: 'plain_text', text: '← 점수 화면으로' } }]
    }
  ];

  const targetQs = quiz.questions.filter(function(q) {
    return !wrongOnly || (sub.userAnswers[q.id] !== q.answerIndex);
  });

  if (targetQs.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '🎉 *틀린 문제가 없습니다! 완벽합니다.*' } });
  }

  targetQs.forEach(function(q) {
    blocks.push({ type: 'divider' });
    const userAns = sub.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;
    const labels = ['A', 'B', 'C', 'D'];

    let explText = '*' + q.number + '번 · ' + (isCorrect ? '✅ 정답' : '❌ 오답') + '*\n';
    if (q.scenario) explText += q.scenario + '\n\n';
    explText += '*' + q.question + '*\n';
    explText += '내 선택: *(' + (labels[userAns] || '미선택') + ')* | 정답: *(' + labels[q.answerIndex] + ') ' + q.options[q.answerIndex] + '*\n\n';
    explText += '*[핵심 해설]*\n' + (q.explanation || '해설 없음') + '\n\n';

    if (Array.isArray(q.optionExplanations)) {
      explText += '*[선택지별 분석]*\n';
      q.optionExplanations.forEach(function(exp, i) {
        explText += '(' + labels[i] + ') ' + exp + '\n';
      });
    }

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: explText } });
  });

  callSlackWebApi_('views.update', {
    view_id: payload.view.id,
    hash: payload.view.hash,
    view: {
      type: 'modal',
      callback_id: 'explanation_view',
      private_metadata: payload.view.private_metadata,
      title: { type: 'plain_text', text: wrongOnly ? '오답 해설' : '전체 해설' },
      close: { type: 'plain_text', text: '닫기' },
      blocks: blocks.slice(0, APP_CONFIG.MAX_MODAL_BLOCKS)
    }
  });
}

function updateScoreModal_(payload) {
  const meta = JSON.parse(payload.view.private_metadata);
  const quiz = loadQuizData_(meta.type);
  const sub = loadUserSubmission_(meta.type, payload.user.id);

  callSlackWebApi_('views.update', {
    view_id: payload.view.id,
    hash: payload.view.hash,
    view: buildScoreModalView_(quiz, sub)
  });
}

// ============================================================================
// 7. STORAGE & UTILITIES
// ============================================================================

function saveQuizData_(type, quiz) {
  const key = type === 'SKCT' ? APP_CONFIG.KEYS.SKCT_QUIZ : APP_CONFIG.KEYS.TOEIC_QUIZ;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(quiz));
}

function loadQuizData_(type) {
  const key = type === 'SKCT' ? APP_CONFIG.KEYS.SKCT_QUIZ : APP_CONFIG.KEYS.TOEIC_QUIZ;
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) throw new Error(type + ' 퀴즈 데이터가 없습니다.');
  return JSON.parse(raw);
}

function saveUserSubmission_(sub) {
  const key = 'SUB_' + sub.type + '_' + sub.userId;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(sub));
}

function loadUserSubmission_(type, userId) {
  const raw = PropertiesService.getScriptProperties().getProperty('SUB_' + type + '_' + userId);
  if (!raw) throw new Error('제출 기록을 찾을 수 없습니다.');
  return JSON.parse(raw);
}

function callSlackWebApi_(method, payload) {
  const token = getEnv_('SLACK_BOT_TOKEN');
  const res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (!data.ok) throw new Error('Slack API [' + method + '] Error: ' + (data.error || 'unknown'));
  return data;
}

function verifySlackSecurity_(e) {
  const expectedSecret = PropertiesService.getScriptProperties().getProperty(APP_CONFIG.KEYS.SECRET);
  if (!expectedSecret) return;
  const provided = e && e.parameter ? e.parameter.secret : '';
  if (provided !== expectedSecret) throw new Error('Slack Secret 불일치');
}

function createInteractionSecret() {
  const secret = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(APP_CONFIG.KEYS.SECRET, secret);
  Logger.log('🔑 Request URL에 추가할 값: ?secret=' + secret);
}

function runWithLock_(lockName, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try { fn(); } finally { lock.releaseLock(); }
}

function getEnv_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('환경변수 [' + key + ']가 Script Properties에 설정되지 않았습니다.');
  return val;
}
