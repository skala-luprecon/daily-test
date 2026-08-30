/**
 * ============================================================================
 * [Next-Gen Unified Slack Quiz Bot Architecture] - Code.gs
 * ============================================================================
 * 
 * 💡 아키텍처 설계 철학 및 핵심 기능:
 * 
 * 1. [자가 치유형 방어적 파싱 (Self-Healing & Defensive Parsing)]
 *    - JSON 수리 및 사소한 마커/포맷 자동 정제(Auto-Sanitizing)로 불필요한 재시도 0% 달성.
 * 
 * 2. [토익 RC 850+ & SKCT 인지역량 단일 통합 엔진 (Unified Engine)]
 *    - 토익 RC: Part 5(5Q) + Part 6(4Q) + Part 7(요일별 단일/이중/삼중 3~5Q) 850+ 킬러 세트.
 *    - SKCT: 4대 핵심 인지역량(언어이해, 창의수리, 언어추리, 수열추리) 8문항 실전 세트.
 * 
 * 3. [엔터프라이즈급 인프라 & 안정성]
 *    - Gemini API: Primary(gemini-3.6-flash) -> Fallback(gemini-3.5-flash) 자동 전환.
 *    - Storage: Google Apps Script Properties 9KB 용량 제한 우회 청크 분할 저장.
 *    - Slack: Block Kit 75자 규격 준수, 지문 다중 카드 독립 렌더링, 군더더기 없는 비즈니스 톤 UI.
 * ============================================================================
 */

// ============================================================================
// 1. GLOBAL CONFIGURATION
// ============================================================================
const APP_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  
  // Gemini 모델 계층
  PRIMARY_MODEL: 'gemini-3.6-flash',
  FALLBACK_MODEL: 'gemini-3.5-flash',
  
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

// SKCT 4대 핵심 인지역량 (자료해석 도표 영역은 임시 보류/주석 처리)
const SKCT_AREAS = Object.freeze({
  verbal_comprehension: { label: '언어이해', count: 2 },
  // data_interpretation:  { label: '자료해석', count: 2 }, // [보류] 도표 렌더링 고도화 시 활성화
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
    'Create exactly 8 original, challenging SKCT practice questions covering the 4 core cognitive domains (2 questions per domain).',
    'Language: All user-visible scenarios, questions, options, and explanations MUST be in refined, professional Korean.',
    '',
    'DOMAIN SPECIFICATIONS (Exactly 2 questions each):',
    '1. "verbal_comprehension" (언어이해): Deep corporate/tech/economic editorial reading. Include subtle traps in options via paraphrasing, conditional qualifiers, and fact-checking.',
    '// 2. "data_interpretation" (자료해석): [임시 보류/주석 처리]',
    '2. "creative_math" (창의수리): Speed/distance/time with two moving bodies or varying speeds, multi-stage mixture/concentration (농도), cost-margin-discount algebra, complex work rates, or combination/probability.',
    '3. "verbal_reasoning" (언어추리): Syllogism (삼단논법/전제결론 제시형), strict truth-teller/liar puzzle (진실게임), or 4-5 entity multi-attribute grid placement under <조건>. Ensure exactly one airtight logical solution.',
    '4. "sequence_reasoning" (수열추리): Non-trivial numerical sequence deduction (e.g. geometric difference series, alternating compound operations, quadratic recurrence). Present clearly as "a, b, c, d, e, (?)" and provide the exact mathematical formula in explanation.',
    '',
    'CRITICAL OPTION CONCISENESS RULE:',
    '- All 4 options (A, B, C, D) MUST be concisely phrased under 40 Korean characters. Never write overly verbose options.',
    '',
    'OUTPUT SCHEMA (Valid JSON only, no markdown commentary):',
    '{',
    '  "questions": [',
    '    {',
    '      "domain": "verbal_comprehension" | "creative_math" | "verbal_reasoning" | "sequence_reasoning",',
    '      "difficulty": "medium" | "hard",',
    '      "scenario": "string (Passage, constraints under <조건>)",',
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
  if (!Array.isArray(questions) || questions.length !== 8) {
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
    q.options = q.options.map(sanitizeOptionText_);
    q.answerIndex = Number(q.answerIndex) || 0;
  });

  return {
    type: 'SKCT',
    title: 'SKCT 인지역량 실전 평가',
    testId: 'SKCT_' + date.replace(/-/g, ''),
    date: date,
    model: res.model,
    questions: questions
  };
}

/**
 * 요일별 Part 7 지문 규격 및 문항 수 결정:
 * - 월/화 (1, 2): 단일 지문 1개 (3문항) ➡️ 데일리 총 12문항
 * - 수/목 (3, 4): 이중 지문 1세트 (5문항) ➡️ 데일리 총 14문항
 * - 금/주말 (5, 6, 0): 삼중 지문 1세트 (5문항) ➡️ 데일리 총 14문항
 */
function getPart7DayConfig_() {
  const day = new Date().getDay(); // 0:일, 1:월, 2:화, 3:수, 4:목, 5:금, 6:토

  if (day === 1 || day === 2) {
    return {
      mode: 'single',
      dayLabel: '단일 지문 집중',
      part7Info: 'Part 7 단일 3Q',
      setName: 'Part 7 · Single Passage (단일 지문)',
      instruction: 'PART 7 SINGLE PASSAGE: Generate exactly 1 comprehensive business document (Article/Notice/Memo, 200-240 words) with exactly 3 challenging questions (Q1: Purpose/Topic, Q2: NOT/TRUE Fact-check, Q3: Contextual Synonym or Inference).'
    };
  } else if (day === 3 || day === 4) {
    return {
      mode: 'double',
      dayLabel: '이중 연계 지문 집중',
      part7Info: 'Part 7 이중 5Q',
      setName: 'Part 7 · Double Passage (이중 연계 지문)',
      instruction: 'PART 7 DOUBLE PASSAGE: Generate exactly 2 heavily linked documents (e.g. Document 1: Job Notice/Webpage + Document 2: Inquiry Email/Application) with exactly 5 challenging questions (Q1: Detail on Doc 1, Q2: Detail on Doc 2, Q3: NOT/TRUE question, Q4: CROSS-REFERENCING INFERENCE between Doc 1 & Doc 2, Q5: Synonym or 2nd Cross-referencing question).'
    };
  } else {
    return {
      mode: 'triple',
      dayLabel: '삼중 복합 연계 지문',
      part7Info: 'Part 7 삼중 5Q',
      setName: 'Part 7 · Triple Passage (삼중 연계 지문)',
      instruction: 'PART 7 TRIPLE PASSAGE: Generate exactly 3 heavily linked documents (e.g. Doc 1: Conference Schedule + Doc 2: Relocation Notice + Doc 3: Attendee Inquiry Email) with exactly 5 challenging questions (Q1: Detail on Doc 1, Q2: Detail on Doc 2, Q3: NOT/TRUE question, Q4: CROSS-REFERENCING between Doc 1 & 2, Q5: MULTI-DOCUMENT INFERENCE linking all 3 documents).'
    };
  }
}

/** TOEIC RC 고난도 생성기 (Part 5: 5Q, Part 6: 4Q, Part 7: 3Q or 5Q) */
function generateToeicQuizUnified_(date) {
  const dayCfg = getPart7DayConfig_();

  const prompt = [
    'You are an expert senior test writer for ETS TOEIC Advanced (850-990 score band).',
    'Date: ' + date,
    'Target Schedule: ' + dayCfg.dayLabel,
    '',
    'EXACT QUESTION STRUCTURE:',
    '1. PART 5: Exactly 5 challenging grammar & vocabulary questions (Questions 1 to 5).',
    '2. PART 6: Exactly 1 Business Document with blanks [1], [2], [3], [4] and exactly 4 questions (Questions 6 to 9, where Q8 is Sentence Insertion).',
    '3. ' + dayCfg.instruction,
    '',
    'CRITICAL OPTION CONCISENESS RULES (MANDATORY):',
    '- Every option (A, B, C, D) across all questions MUST be strictly concise and under 60 characters in English.',
    '- Use natural, compact ETS phrasing (e.g. "Hotel costs are paid upfront" instead of "Employees must pay for their hotel accommodation upfront and request reimbursement").',
    '- Never write long run-on sentences in options so they fit Slack radio buttons without clipping.',
    '',
    'CRITICAL PASSAGE FORMATTING RULES:',
    '- In Part 6, the passage must contain blanks [1], [2], [3], [4].',
    '- In Part 7, provide "documents": [ {"documentType": "Document 1: ...", "text": "..."} ... ] (1 document for single, 2 for double, 3 for triple).',
    '- In the JSON "question" field for Part 6, write simply "Select the best option for the blank." (Do not put [1] in question).',
    '',
    'OUTPUT SCHEMA (Strictly valid JSON only):',
    '{',
    '  "part5": { "questions": [ { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Korean", "optionExplanations": ["A","B","C","D"] } ] },',
    '  "part6": { "documentType": "Business Email", "passage": "English with [1],[2],[3],[4]", "passageTranslation": "Korean", "questions": [ { "blankNumber": 1, "question": "Select the best option for the blank.", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Korean", "optionExplanations": ["A","B","C","D"] } ] },',
    '  "part7": {',
    '    "setName": "' + dayCfg.setName + '",',
    '    "documents": [ { "documentType": "Document 1: ...", "text": "..." } ],',
    '    "questions": [ { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "Korean", "optionExplanations": ["A","B","C","D"] } ]',
    '  }',
    '}'
  ].join('\n');

  const res = callGeminiRobust_(prompt, 0.55);
  const data = res.data;

  const unifiedQuestions = [];
  let qNum = 1;

  // Part 5 처리 (5문항)
  if (data.part5 && Array.isArray(data.part5.questions)) {
    data.part5.questions.forEach(function(q) {
      q.id = 'TOEIC_Q' + qNum;
      q.number = qNum++;
      q.part = 'Part 5 · Incomplete Sentences';
      q.scenario = '';
      q.options = q.options.map(sanitizeOptionText_);
      unifiedQuestions.push(q);
    });
  }

  // Part 6 처리 (4문항)
  if (data.part6 && Array.isArray(data.part6.questions)) {
    const p6Scenario = '```\n[' + data.part6.documentType + ']\n\n' + data.part6.passage + '\n```';
    data.part6.questions.forEach(function(q, idx) {
      q.id = 'TOEIC_Q' + qNum;
      q.number = qNum++;
      q.part = 'Part 6 · Text Completion';
      q.blankNumber = q.blankNumber || (idx + 1);
      q.scenario = p6Scenario;
      q.question = (q.blankNumber === 3 ? '[3]번 빈칸 (알맞은 문장 선택)' : '[' + q.blankNumber + ']번 빈칸 선택');
      q.options = q.options.map(sanitizeOptionText_);
      unifiedQuestions.push(q);
    });
  }

  // Part 7 처리 (단일: 3문항 / 복합: 5문항)
  if (data.part7 && Array.isArray(data.part7.questions) && Array.isArray(data.part7.documents)) {
    const docCards = data.part7.documents.map(function(doc, dIdx) {
      const docType = doc.documentType || ('Document ' + (dIdx + 1));
      const cleanText = String(doc.text || '').replace(/```/g, '').trim();
      return '```\n[' + docType + ']\n\n' + cleanText + '\n```';
    }).join('\n\n');

    data.part7.questions.forEach(function(q) {
      q.id = 'TOEIC_Q' + qNum;
      q.number = qNum++;
      q.part = data.part7.setName || dayCfg.setName;
      q.scenario = docCards;
      q.options = q.options.map(sanitizeOptionText_);
      unifiedQuestions.push(q);
    });
  }

  return {
    type: 'TOEIC',
    title: 'TOEIC RC 실전 평가 (' + dayCfg.dayLabel + ')',
    part7Info: dayCfg.part7Info,
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
  const actionId = type === 'SKCT' ? 'open_skct_modal' : 'open_toeic_modal';
  const btnText = type === 'SKCT' ? '테스트 시작 (SKCT) →' : '테스트 시작 (TOEIC) →';

  let headerTitle = '';
  let detailLines = [];
  let summaryText = '';

  if (type === 'SKCT') {
    headerTitle = '📌 SKCT 인지역량 Daily Test (' + quiz.date + ')';
    detailLines = [
      '• *언어이해*: 2문항',
      // '• *자료해석*: 2문항', // [보류]
      '• *창의수리*: 2문항',
      '• *언어추리*: 2문항',
      '• *수열추리*: 2문항'
    ];
    summaryText = '*총 8문항* · 권장 시간: 12분';
  } else {
    headerTitle = '📌 TOEIC RC Daily Test (' + quiz.date + ')';

    let part7Label = '복합 연계 독해 (5문항)';
    if (quiz.part7Info && quiz.part7Info.indexOf('단일') !== -1) {
      part7Label = '단일 지문 독해 (3문항)';
    } else if (quiz.part7Info && quiz.part7Info.indexOf('이중') !== -1) {
      part7Label = '이중 연계 독해 (5문항)';
    } else if (quiz.part7Info && quiz.part7Info.indexOf('삼중') !== -1) {
      part7Label = '삼중 연계 독해 (5문항)';
    }

    detailLines = [
      '• *Part 5* (단문 공란 채우기): 5문항',
      '• *Part 6* (장문 공란 채우기): 4문항',
      '• *Part 7* (' + part7Label + ')'
    ];
    summaryText = '*총 ' + quiz.questions.length + '문항* · 권장 시간: ' + (quiz.questions.length > 12 ? '15분' : '12분');
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerTitle, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: detailLines.join('\n') + '\n\n' + summaryText
      }
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
  const modalHeaderTitle = type === 'SKCT' ? 'SKCT 인지역량 평가' : 'TOEIC RC 실전 평가';
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*' + quiz.date + ' ' + quiz.title + '*\n모든 문항의 답안을 선택하신 후 하단의 [답안 제출] 버튼을 눌러주세요.'
      }
    }
  ];

  let lastRenderedScenario = '';
  let lastRenderedPart = '';

  quiz.questions.forEach(function(q) {
    // 1) 파트가 바뀔 때만 파트 헤더 1회 출력 (예: 📖 Part 5 · Incomplete Sentences)
    if (q.part && q.part !== lastRenderedPart) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'header', text: { type: 'plain_text', text: '📖 ' + q.part, emoji: true } });
      lastRenderedPart = q.part;
    } else {
      blocks.push({ type: 'divider' });
    }

    // 2) 동일 지문 중복 방지 (지문이 있고 이전 문제의 지문과 다를 때만 1회 출력)
    if (q.scenario && q.scenario !== lastRenderedScenario) {
      renderScenarioCards_(blocks, q.scenario);
      lastRenderedScenario = q.scenario;
    }

    // 3) 질문 라벨: 중복 파트명 없이 '1번. 문제내용' 형태로 깔끔하게 결합
    let questionTitle = q.number + '번. ';
    if (q.domain && SKCT_AREAS[q.domain]) {
      questionTitle += '[' + SKCT_AREAS[q.domain].label + '] ';
    }
    questionTitle += (q.question || '정답을 선택하세요.');
    questionTitle = questionTitle.slice(0, 1900);

    // 4) 문제 및 선택지 라디오 버튼 렌더링 (단일 input 블록으로 군더더기 없이 통합)
    blocks.push({
      type: 'input',
      block_id: q.id,
      label: { type: 'plain_text', text: questionTitle },
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
      title: { type: 'plain_text', text: modalHeaderTitle },
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

  let lastRenderedScenario = '';
  let lastRenderedPart = '';

  targetQs.forEach(function(q) {
    if (q.part && q.part !== lastRenderedPart) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'header', text: { type: 'plain_text', text: '📖 ' + q.part, emoji: true } });
      lastRenderedPart = q.part;
    } else {
      blocks.push({ type: 'divider' });
    }

    // 동일 지문 중복 방지 (지문이 있고 이전 문제의 지문과 다를 때만 1회 출력)
    if (q.scenario && q.scenario !== lastRenderedScenario) {
      renderScenarioCards_(blocks, q.scenario);
      lastRenderedScenario = q.scenario;
    }

    const userAns = sub.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;
    const labels = ['A', 'B', 'C', 'D'];

    let explText = '*' + q.number + '번 · ' + (isCorrect ? '✅ 정답' : '❌ 오답') + '*\n';
    explText += '*' + q.question + '*\n';
    explText += '내 선택: *(' + (labels[userAns] || '미선택') + ')* | 정답: *(' + labels[q.answerIndex] + ') ' + q.options[q.answerIndex] + '*\n\n';
    explText += '*[핵심 해설]*\n' + (q.explanation || '해설 없음') + '\n\n';

    if (Array.isArray(q.optionExplanations)) {
      explText += '*[선택지별 분석]*\n';
      q.optionExplanations.forEach(function(exp, i) {
        explText += '(' + labels[i] + ') ' + exp + '\n';
      });
    }

    addSafeSectionChunks_(blocks, explText);
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
  saveChunked_(key, JSON.stringify(quiz));
}

function loadQuizData_(type) {
  const key = type === 'SKCT' ? APP_CONFIG.KEYS.SKCT_QUIZ : APP_CONFIG.KEYS.TOEIC_QUIZ;
  const raw = loadChunked_(key);
  if (!raw) throw new Error(type + ' 퀴즈 데이터가 없습니다.');
  return JSON.parse(raw);
}

function saveUserSubmission_(sub) {
  const key = 'SUB_' + sub.type + '_' + sub.userId;
  saveChunked_(key, JSON.stringify(sub));
}

function loadUserSubmission_(type, userId) {
  const key = 'SUB_' + type + '_' + userId;
  const raw = loadChunked_(key);
  if (!raw) throw new Error('제출 기록을 찾을 수 없습니다.');
  return JSON.parse(raw);
}

/** Google Apps Script Properties 9KB 용량 제한 우회 분할 저장기 */
function saveChunked_(baseKey, strValue) {
  const props = PropertiesService.getScriptProperties();
  const CHUNK_SIZE = 7500;
  const totalChunks = Math.ceil(strValue.length / CHUNK_SIZE);

  // 기존 청크 정리
  const oldMeta = props.getProperty(baseKey + '_META');
  if (oldMeta) {
    const count = Number(oldMeta) || 0;
    for (let i = 0; i < count; i++) {
      props.deleteProperty(baseKey + '_C' + i);
    }
  }

  if (totalChunks <= 1) {
    props.setProperty(baseKey, strValue);
    props.deleteProperty(baseKey + '_META');
    return;
  }

  props.deleteProperty(baseKey);
  props.setProperty(baseKey + '_META', String(totalChunks));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = strValue.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    props.setProperty(baseKey + '_C' + i, chunk);
  }
}

/** 분할 저장된 대용량 퀴즈 데이터 복원 로더 */
function loadChunked_(baseKey) {
  const props = PropertiesService.getScriptProperties();
  const meta = props.getProperty(baseKey + '_META');

  if (!meta) {
    return props.getProperty(baseKey);
  }

  const totalChunks = Number(meta) || 0;
  let fullStr = '';
  for (let i = 0; i < totalChunks; i++) {
    const chunk = props.getProperty(baseKey + '_C' + i);
    if (chunk) fullStr += chunk;
  }
  return fullStr || null;
}

/** 지문 카드를 Slack Block Kit의 독립된 개별 section들로 안전하게 분리 렌더링 (백틱 깨짐 0%) */
function renderScenarioCards_(blocks, scenario) {
  if (!scenario) return;

  const raw = String(scenario).trim();
  const cardRegex = /```[\s\S]*?```/g;
  const matches = raw.match(cardRegex);

  if (matches && matches.length > 0) {
    // 2개 이상의 독립 카드인 경우 각각 개별 section 블록으로 등록
    matches.forEach(function(card) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: card.trim() }
      });
    });
  } else {
    // 단일 카드 또는 일반 텍스트인 경우
    addSafeSectionChunks_(blocks, raw);
  }
}

/** Slack radio_buttons 75자 제한 준수 및 단어 경계 안전 자르기 */
function sanitizeOptionText_(opt) {
  let s = String(opt || '').trim();
  if (s.length <= 70) return s;
  let cut = s.slice(0, 67);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 45) cut = cut.slice(0, lastSpace);
  return cut.trim() + '...';
}

/** Slack Section 블록 3,000자 초과 방지 안전 분할기 */
function addSafeSectionChunks_(blocks, text) {
  if (!text) return;
  const MAX_CHUNK = 2800;
  if (text.length <= MAX_CHUNK) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text } });
    return;
  }
  let pos = 0;
  while (pos < text.length) {
    let nextPos = pos + MAX_CHUNK;
    if (nextPos < text.length) {
      const splitIdx = text.lastIndexOf('\n', nextPos);
      if (splitIdx > pos + 1000) nextPos = splitIdx + 1;
    }
    const chunk = text.slice(pos, nextPos).trim();
    if (chunk) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
    pos = nextPos;
  }
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
