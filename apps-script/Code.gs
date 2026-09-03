/**
 * ============================================================================
 * [Next-Gen Unified Slack Quiz Bot Architecture] - Code.gs
 * ============================================================================
 * 
 * 아키텍처 설계 철학 및 핵심 기능:
 * 
 * 1. [자가 치유형 방어적 파싱 (Self-Healing & Defensive Parsing)]
 *    - JSON 수리 및 사소한 마커/포맷 자동 정제(Auto-Sanitizing)로 불필요한 재시도 0% 달성.
 * 
 * 2. [토익 RC 850+ & SKCT 인지역량 단일 통합 엔진 (Unified Engine)]
 *    - 토익 RC: Part 5(5Q) + Part 6(4Q) + Part 7(요일별 단일/이중/삼중 3~5Q) 850+ 킬러 세트.
 *    - SKCT: 4대 핵심 인지역량(언어이해, 창의수리, 언어추리, 수열추리) 8문항 실전 세트.
 * 
 * 3. [엔터프라이즈급 인프라 & 안정성]
 *    - Gemini API: Primary(gemini-3.8-flash, 최대 3회 1분간격 재시도) -> Fallback(gemini-3.7-flash) 고성능 계층화.
 *    - Storage: Google Apps Script Properties 9KB 제한 우회 청크 스토리지 & Slack View 무상태화.
 *    - Slack: Block Kit 75자 규격 준수, 지문 다중 카드 독립 렌더링, 군더더기 없는 비즈니스 톤 UI.
 * ============================================================================
 */

// ============================================================================
// 1. GLOBAL CONFIGURATION
// ============================================================================
const APP_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  GITHUB_REPO: 'skala-luprecon/daily-test',
  
  // Gemini 모델 계층
  PRIMARY_MODEL: 'gemini-3.8-flash',
  FALLBACK_MODEL: 'gemini-3.7-flash',
  
  // API 제어 및 503 재시도 정책
  MAX_RETRIES: 3,                   // Primary 모델 최대 3회 시도
  RETRY_DELAY_MS: 60 * 1000,        // 503 일시 장애 대응: 재시도 간 1분(60초) 대기
  MAX_OUTPUT_TOKENS: 30000,
  MIN_API_INTERVAL_MS: 15000,
  
  // 제약 조건
  CHUNK_SIZE: 7500,
  MAX_MODAL_BLOCKS: 90,
  MAX_SECTION_CHARS: 2800,
  
  // Storage Keys
  KEYS: {
    TOEIC_QUIZ: 'QUIZ_TOEIC_CURRENT',
    SKCT_QUIZ: 'QUIZ_SKCT_CURRENT',
    SECRET: 'SLACK_INTERACTION_SECRET',
    LAST_API_CALL: 'LAST_GEMINI_API_CALL',
    GITHUB_TOKEN: 'GITHUB_TOKEN'
  }
});

// SKCT 4대 핵심 인지역량
const SKCT_AREAS = Object.freeze({
  verbal_comprehension: { label: '언어이해', count: 2 },
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
  return ContentService.createTextOutput('Unified Daily Test Bot Engine is Running Healthy.');
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

  Logger.log('[트리거] Daily 트리거 설치 완료 (07:00 TOEIC RC, 08:00 SKCT 5대 영역)');
}

function triggerDailyToeic() {
  runWithLock_(function() {
    const date = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
    const quiz = generateToeicQuizUnified_(date);
    saveQuizData_('TOEIC', quiz);
    postLauncherToSlack_('TOEIC', quiz);
  });
}

function triggerDailySkct() {
  runWithLock_(function() {
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
  const apiKey = getEnv_('GEMINI_API_KEY');
  const maxRetries = APP_CONFIG.MAX_RETRIES || 3;
  const retryDelayMs = APP_CONFIG.RETRY_DELAY_MS || 60000;
  let lastErr = null;

  // 1. Primary Model (gemini-3.8-flash) 최대 3회 시도 (1분 간격)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      Logger.log('[' + APP_CONFIG.PRIMARY_MODEL + '] 호출 시도 (' + attempt + '/' + maxRetries + ')...');
      const result = executeGeminiRequest_(APP_CONFIG.PRIMARY_MODEL, prompt, customTemp, apiKey);
      Logger.log('[' + APP_CONFIG.PRIMARY_MODEL + '] 호출 성공 (시도 ' + attempt + '회차)');
      return { data: result, model: APP_CONFIG.PRIMARY_MODEL };
    } catch (err) {
      lastErr = err;
      Logger.log('[경고] [' + APP_CONFIG.PRIMARY_MODEL + '] 시도 ' + attempt + '/' + maxRetries + ' 실패: ' + err.message);
      if (attempt < maxRetries) {
        Logger.log('[대기] 503/일시 오류 대응: ' + Math.round(retryDelayMs / 1000) + '초(1분) 동안 대기 후 재시도합니다...');
        Utilities.sleep(retryDelayMs);
      }
    }
  }

  // 2. Primary Model 3회 실패 시 Fallback Model (gemini-3.7-flash) 긴급 구동
  if (APP_CONFIG.FALLBACK_MODEL && APP_CONFIG.FALLBACK_MODEL !== APP_CONFIG.PRIMARY_MODEL) {
    try {
      Logger.log('[재시도 실패] [' + APP_CONFIG.PRIMARY_MODEL + '] 3회 재시도 모두 실패 -> [' + APP_CONFIG.FALLBACK_MODEL + '] Fallback 호출 실행');
      const result = executeGeminiRequest_(APP_CONFIG.FALLBACK_MODEL, prompt, customTemp, apiKey);
      Logger.log('[성공] [' + APP_CONFIG.FALLBACK_MODEL + '] Fallback 호출 성공');
      return { data: result, model: APP_CONFIG.FALLBACK_MODEL };
    } catch (fallbackErr) {
      Logger.log('[오류] Fallback [' + APP_CONFIG.FALLBACK_MODEL + '] 호출 실패: ' + fallbackErr.message);
      lastErr = fallbackErr;
    }
  }

  throw new Error('모든 Gemini 모델 호출 실패: ' + (lastErr ? lastErr.message : 'Unknown'));
}

function executeGeminiRequest_(model, prompt, customTemp, apiKey) {
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

  return parseAndRepairJson_(rawText);
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
    '2. "creative_math" (창의수리): Speed/distance/time with two moving bodies or varying speeds, multi-stage mixture/concentration (농도), cost-margin-discount algebra, complex work rates, or combination/probability.',
    '3. "verbal_reasoning" (언어추리): Syllogism (삼단논법/전제결론 제시형), strict truth-teller/liar puzzle (진실게임), or 4-5 entity multi-attribute grid placement under <조건>. Ensure exactly one airtight logical solution.',
    '4. "sequence_reasoning" (수열추리): Non-trivial numerical sequence deduction (e.g. geometric difference series, alternating compound operations, quadratic recurrence). Present clearly as "a, b, c, d, e, (?)" and provide the exact mathematical formula in explanation.',
    '',
    'CRITICAL OPTION CONCISENESS & FORMATTING RULES:',
    '- All 4 options MUST be concisely phrased under 40 Korean characters.',
    '- Write ONLY the pure choice text! NEVER include prefixes like "(A)", "A.", or "Option A" in the strings.',
    '- The UI and Slack automatically generate the (A), (B), (C), (D) badges dynamically.',
    '',
    'CRITICAL MANDATORY RULE: RANDOMIZED & BALANCED ANSWER DISTRIBUTION',
    '- The correct answer index ("answerIndex": 0, 1, 2, or 3 representing A, B, C, D) MUST be strictly and evenly distributed across the 8 questions.',
    '- Exactly 2 questions for each choice: 2 A(0)s, 2 B(1)s, 2 C(2)s, 2 D(3)s.',
    '- NEVER make consecutive questions have the same answer index (e.g. C, C, C is strictly forbidden).',
    '- When writing options, randomize which position contains the correct answer.',
    '',
    'OUTPUT SCHEMA (Valid JSON only, no markdown commentary):',
    '{',
    '  "questions": [',
    '    {',
    '      "domain": "verbal_comprehension" | "creative_math" | "verbal_reasoning" | "sequence_reasoning",',
    '      "difficulty": "medium" | "hard",',
    '      "scenario": "string (Passage, constraints under <조건>)",',
    '      "question": "string (Standard Korean phrasing like: 다음 글을 읽고 알 수 있는 것은?, 다음 조건을 만족할 때 항상 참인 것은?)",',
    '      "options": ["첫 번째 보기 내용", "두 번째 보기 내용", "세 번째 보기 내용", "네 번째 보기 내용"],',
    '      "answerIndex": 1,',
    '      "explanation": "string (Step-by-step mathematical or logical solution)",',
    '      "optionExplanations": ["1번 보기 해설", "2번 보기 해설", "3번 보기 해설", "4번 보기 해설"]',
    '    }',
    '  ]',
    '}'
  ].join('\n');

  const res = callGeminiRobust_(prompt, 0.45);
  let questions = res.data.questions;
  if (!Array.isArray(questions) || questions.length !== 8) {
    throw new Error('SKCT 문항 수 불일치: ' + (questions ? questions.length : 0));
  }

  // 자가 복구 및 정제 (Sanitization)
  questions.forEach(function(q, idx) {
    q.id = 'SKCT_Q' + (idx + 1);
    q.number = idx + 1;
    let sc = String(q.scenario || '').trim();
    if (sc) {
      // 슬랙 모달에서 회색 박스 카드로 렌더링되도록 백틱 코드블록 규격화
      sc = sc.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      q.scenario = '```\n' + sc + '\n```';
    } else {
      q.scenario = '';
    }
    q.question = String(q.question || '').trim();
    
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(q.id + ' 선택지 개수 오류');
    }
    q.options = q.options.map(sanitizeOptionText_);
    q.answerIndex = Number(q.answerIndex) || 0;
  });

  // 정답 편중 방어 및 균등 분포 보정
  questions = enforceBalancedAnswers_(questions);

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
 * - 월/화 (1, 2): 단일 지문 1개 (3문항) -> 데일리 총 12문항
 * - 수/목 (3, 4): 이중 지문 1세트 (5문항) -> 데일리 총 14문항
 * - 금/주말 (5, 6, 0): 삼중 지문 1세트 (5문항) -> 데일리 총 14문항
 */
function getPart7DayConfig_() {
  const day = new Date().getDay(); // 0:일, 1:월, 2:화, 3:수, 4:목, 5:금, 6:토

  if (day === 1 || day === 2) {
    return {
      mode: 'single',
      dayLabel: '단일 지문 집중',
      part7Info: 'Part 7 단일 3Q',
      part7Label: '단일 지문 독해 (3문항)',
      setName: 'Part 7 · Single Passage (단일 지문)',
      instruction: 'PART 7 SINGLE PASSAGE: Generate exactly 1 comprehensive business document (Article/Notice/Memo, 200-240 words) with exactly 3 challenging questions (Q1: Purpose/Topic, Q2: NOT/TRUE Fact-check, Q3: Contextual Synonym or Inference).'
    };
  } else if (day === 3 || day === 4) {
    return {
      mode: 'double',
      dayLabel: '이중 연계 지문 집중',
      part7Info: 'Part 7 이중 5Q',
      part7Label: '이중 연계 독해 (5문항)',
      setName: 'Part 7 · Double Passage (이중 연계 지문)',
      instruction: 'PART 7 DOUBLE PASSAGE: Generate exactly 2 heavily linked documents (e.g. Document 1: Job Notice/Webpage + Document 2: Inquiry Email/Application) with exactly 5 challenging questions (Q1: Detail on Doc 1, Q2: Detail on Doc 2, Q3: NOT/TRUE question, Q4: CROSS-REFERENCING INFERENCE between Doc 1 & Doc 2, Q5: Synonym or 2nd Cross-referencing question).'
    };
  } else {
    return {
      mode: 'triple',
      dayLabel: '삼중 복합 연계 지문',
      part7Info: 'Part 7 삼중 5Q',
      part7Label: '삼중 연계 독해 (5문항)',
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
    'CRITICAL OPTION CONCISENESS & FORMATTING RULES (MANDATORY):',
    '- Every option across all questions MUST be strictly concise and under 60 characters in English.',
    '- Use natural, compact ETS phrasing (e.g. "Hotel costs are paid upfront").',
    '- Write ONLY the pure choice text! NEVER include prefixes like "(A)", "A.", or "Option A" in the option strings (e.g. write "commensurate", NOT "(A) commensurate").',
    '- The UI and Slack dynamically prepend (A), (B), (C), (D) badges to each option.',
    '',
    'CRITICAL PASSAGE FORMATTING RULES:',
    '- In Part 6, the passage must contain blanks [1], [2], [3], [4].',
    '- In Part 7, provide "documents": [ {"documentType": "Document 1: ...", "text": "..."} ... ] (1 document for single, 2 for double, 3 for triple).',
    '',
    'CRITICAL MANDATORY RULE: RANDOMIZED & BALANCED ANSWER DISTRIBUTION',
    '- The correct answer index ("answerIndex": 0, 1, 2, or 3 representing A, B, C, D) MUST be evenly and unpredictably distributed across all 14 questions.',
    '- DO NOT put the correct answer at index 0 (A) for most questions! Each letter A(0), B(1), C(2), D(3) must appear approximately 3 to 4 times (roughly 25% each).',
    '- Consecutive identical answers are forbidden: NEVER allow 3 consecutive questions to have the same answer index.',
    '- Randomize the position of the correct answer among options when writing each question.',
    '',
    'OUTPUT SCHEMA (Strictly valid JSON only):',
    '{',
    '  "part5": { "questions": [ { "question": "...", "options": ["choice 1 text", "choice 2 text", "choice 3 text", "choice 4 text"], "answerIndex": 2, "explanation": "Korean", "optionExplanations": ["choice 1 note", "choice 2 note", "choice 3 note", "choice 4 note"] } ] },',
    '  "part6": { "documentType": "Business Email", "passage": "English with [1],[2],[3],[4]", "passageTranslation": "Korean", "questions": [ { "blankNumber": 1, "question": "Select the best option for the blank.", "options": ["choice 1 text", "choice 2 text", "choice 3 text", "choice 4 text"], "answerIndex": 3, "explanation": "Korean", "optionExplanations": ["choice 1 note", "choice 2 note", "choice 3 note", "choice 4 note"] } ] },',
    '  "part7": {',
    '    "setName": "' + dayCfg.setName + '",',
    '    "documents": [ { "documentType": "Document 1: ...", "text": "..." } ],',
    '    "questions": [ { "question": "...", "options": ["choice 1 text", "choice 2 text", "choice 3 text", "choice 4 text"], "answerIndex": 1, "explanation": "Korean", "optionExplanations": ["choice 1 note", "choice 2 note", "choice 3 note", "choice 4 note"] } ]',
    '  }',
    '}'
  ].join('\n');

  const res = callGeminiRobust_(prompt, 0.55);
  const data = res.data;

  let unifiedQuestions = [];
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

  // 정답 편중 방어 및 균등 분포 보정 (A, B, C, D가 약 25%씩 골고루 배치되도록 자동 검증)
  unifiedQuestions = enforceBalancedAnswers_(unifiedQuestions);

  return {
    type: 'TOEIC',
    title: 'TOEIC RC 실전 평가 (' + dayCfg.dayLabel + ')',
    part7Info: dayCfg.part7Info,
    part7Label: dayCfg.part7Label,
    testId: 'TOEIC_' + date.replace(/-/g, ''),
    date: date,
    model: res.model,
    questions: unifiedQuestions
  };
}

/**
 * Ensures answerIndex is evenly distributed across 0, 1, 2, 3 and avoids repetitive duplicates.
 * If the model output is skewed (e.g. > 35% same answer, or 3+ consecutive same answers),
 * it programmatically rebalances by swapping options and optionExplanations in sync.
 */
function enforceBalancedAnswers_(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return questions;

  const total = questions.length;
  const labels = ['A', 'B', 'C', 'D'];
  const counts = [0, 0, 0, 0];
  let hasConsecutiveTriple = false;

  questions.forEach(function(q, i) {
    q.answerIndex = Number(q.answerIndex) || 0;
    counts[q.answerIndex] = (counts[q.answerIndex] || 0) + 1;
    if (i >= 2 && q.answerIndex === questions[i - 1].answerIndex && q.answerIndex === questions[i - 2].answerIndex) {
      hasConsecutiveTriple = true;
    }
  });

  const maxCount = Math.max.apply(null, counts);
  const isSkewed = (maxCount / total > 0.35) || hasConsecutiveTriple;

  if (!isSkewed) {
    Logger.log('[정답 검증] 정답 분포 균형 양호 (A:' + counts[0] + ', B:' + counts[1] + ', C:' + counts[2] + ', D:' + counts[3] + ')');
    return questions;
  }

  Logger.log('[정답 재분배] 정답 편중 감지 (A:' + counts[0] + ', B:' + counts[1] + ', C:' + counts[2] + ', D:' + counts[3] + '). 균형 재배치 실행...');

  // Standard balanced distribution sequence
  // 14 questions: A:3, B:4, C:4, D:3 (Total 14, no 3-in-a-row)
  const pattern14 = [1, 3, 0, 2, 1, 0, 3, 1, 2, 3, 1, 2, 0, 2];
  // 8 questions:  A:2, B:2, C:2, D:2 (Total 8, no 3-in-a-row)
  const pattern8 = [0, 2, 1, 3, 2, 0, 3, 1];

  let targetPattern = [];
  if (total === 14) {
    targetPattern = pattern14;
  } else if (total === 8) {
    targetPattern = pattern8;
  } else {
    for (let i = 0; i < total; i++) {
      targetPattern.push(i % 4);
    }
  }

  questions.forEach(function(q, qIdx) {
    const currIdx = Number(q.answerIndex) || 0;
    const targetIdx = targetPattern[qIdx % targetPattern.length];
    if (currIdx === targetIdx) return;

    const oldLetter = labels[currIdx];
    const newLetter = labels[targetIdx];

    // 1. Swap options
    const tempOpt = q.options[currIdx];
    q.options[currIdx] = q.options[targetIdx];
    q.options[targetIdx] = tempOpt;

    // 2. Swap optionExplanations
    if (Array.isArray(q.optionExplanations) && q.optionExplanations.length === 4) {
      const tempExp = q.optionExplanations[currIdx];
      q.optionExplanations[currIdx] = q.optionExplanations[targetIdx];
      q.optionExplanations[targetIdx] = tempExp;
    }

    // 3. Update explanation letter references
    if (q.explanation) {
      q.explanation = q.explanation.replace(new RegExp('\\(' + oldLetter + '\\)', 'g'), '(' + newLetter + ')');
      q.explanation = q.explanation.replace(new RegExp('\\b' + oldLetter + '(?=[가-힣])', 'g'), newLetter);
    }

    q.answerIndex = targetIdx;
  });

  const newCounts = [0, 0, 0, 0];
  questions.forEach(function(q) {
    newCounts[q.answerIndex]++;
  });
  Logger.log('[정답 재분배 완료] 신규 분포: A:' + newCounts[0] + ', B:' + newCounts[1] + ', C:' + newCounts[2] + ', D:' + newCounts[3]);

  return questions;
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
    headerTitle = 'SKCT 인지역량 Daily Test (' + quiz.date + ')';
    detailLines = [
      '• *언어이해*: 2문항',
      '• *창의수리*: 2문항',
      '• *언어추리*: 2문항',
      '• *수열추리*: 2문항'
    ];
    summaryText = '*총 8문항* · 권장 시간: 12분';
  } else {
    headerTitle = 'TOEIC RC Daily Test (' + quiz.date + ')';
    detailLines = [
      '• *Part 5* (단문 공란 채우기): 5문항',
      '• *Part 6* (장문 공란 채우기): 4문항',
      '• *Part 7* (' + (quiz.part7Label || '복합 연계 독해 (5문항)') + ')'
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
    // 1) 파트가 바뀔 때만 파트 헤더 1회 출력 (예: Part 5 · Incomplete Sentences)
    if (q.part && q.part !== lastRenderedPart) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'header', text: { type: 'plain_text', text: q.part, emoji: false } });
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
    private_metadata: JSON.stringify({
      testId: quiz.testId,
      type: sub.type,
      userId: sub.userId,
      userAnswers: sub.userAnswers,
      correctCount: sub.correctCount,
      totalCount: sub.totalCount
    }),
    title: { type: 'plain_text', text: '채점 결과' },
    close: { type: 'plain_text', text: '닫기' },
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '채점 완료 (' + sub.correctCount + '/' + sub.totalCount + ' 정답)', emoji: false }
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
            text: { type: 'plain_text', text: '전체 해설 보기' },
            value: sub.type
          },
          {
            type: 'button',
            action_id: 'show_explanations_wrong',
            text: { type: 'plain_text', text: '틀린 문제만 보기' },
            value: sub.type
          }
        ]
      }
    ]
  };
}

function updateExplanationModal_(payload, wrongOnly) {
  const sub = JSON.parse(payload.view.private_metadata);
  const quiz = loadQuizData_(sub.type);
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
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*틀린 문제가 없습니다. 완벽합니다.*' } });
  }

  let lastRenderedScenario = '';
  let lastRenderedPart = '';

  targetQs.forEach(function(q) {
    if (q.part && q.part !== lastRenderedPart) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'header', text: { type: 'plain_text', text: q.part, emoji: false } });
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

    let explText = '*' + q.number + '번 · ' + (isCorrect ? '[정답]' : '[오답]') + '*\n';
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
  const sub = JSON.parse(payload.view.private_metadata);
  const quiz = loadQuizData_(sub.type);

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

  // GitHub 저장소에 일자별 JSON 자동 커밋 & 푸시
  try {
    const subFolder = type === 'SKCT' ? 'skct/' : 'toeic/';
    const fileName = quiz.date + '_' + type + '.json';
    const filePath = 'data/' + subFolder + fileName;
    commitFileToGitHub_(filePath, JSON.stringify(quiz, null, 2), 'feat: archive ' + quiz.date + ' ' + type + ' quiz data');
    updateManifestOnGitHub_(quiz.date);
  } catch (err) {
    Logger.log('[경고] GitHub 자동 아카이빙 오류 (무시됨): ' + (err.message || err));
  }
}

function loadQuizData_(type) {
  const key = type === 'SKCT' ? APP_CONFIG.KEYS.SKCT_QUIZ : APP_CONFIG.KEYS.TOEIC_QUIZ;
  const raw = loadChunked_(key);
  if (!raw) throw new Error(type + ' 퀴즈 데이터가 없습니다.');
  return JSON.parse(raw);
}

/** Google Apps Script Properties 9KB 용량 제한 우회 분할 저장기 */
function saveChunked_(baseKey, strValue) {
  const props = PropertiesService.getScriptProperties();
  const CHUNK_SIZE = APP_CONFIG.CHUNK_SIZE;
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
    // 단일 카드 또는 일반 텍스트인 경우 반드시 코드블록(```) 카드 박스로 감싸서 슬랙 블록에 등록
    let cardText = raw;
    if (!cardText.startsWith('```')) {
      cardText = '```\n' + cardText + '\n```';
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: cardText }
    });
  }
}

/** Slack radio_buttons 75자 제한 준수 및 선택지 접두어 정제 */
function sanitizeOptionText_(opt) {
  let s = String(opt || '').trim();
  // 모델이 실수로 포함한 불필요한 번호/알파벳 접두어 자동 제거 (예: "(A) ", "A. ", "A) ", "Option A: ", "① ")
  s = s.replace(/^(?:\([A-Da-d1-4]\)|[A-Da-d1-4][\.\)]|Option\s+[A-Da-d]:?|[①-④])\s*/i, '');
  if (s.length <= 70) return s;
  let cut = s.slice(0, 67);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 45) cut = cut.slice(0, lastSpace);
  return cut.trim() + '...';
}

/** Slack Section 블록 3,000자 초과 방지 안전 분할기 */
function addSafeSectionChunks_(blocks, text) {
  if (!text) return;
  const MAX_CHUNK = APP_CONFIG.MAX_SECTION_CHARS;
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
  Logger.log('Request URL에 추가할 값: ?secret=' + secret);
}

function runWithLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try { fn(); } finally { lock.releaseLock(); }
}

function getEnv_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('환경변수 [' + key + ']가 Script Properties에 설정되지 않았습니다.');
  return val;
}

/** GitHub REST API를 통해 파일 자동 커밋 & 푸시 */
function commitFileToGitHub_(filePath, fileContentStr, commitMessage) {
  const token = PropertiesService.getScriptProperties().getProperty(APP_CONFIG.KEYS.GITHUB_TOKEN);
  if (!token) {
    Logger.log('[정보] GITHUB_TOKEN이 설정되지 않아 GitHub 백업을 건너뜁니다.');
    return;
  }

  const url = 'https://api.github.com/repos/' + APP_CONFIG.GITHUB_REPO + '/contents/' + filePath;

  // 1) 기존 파일의 SHA 조회 (업데이트 시 필수)
  let sha = null;
  try {
    const getRes = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DailyTest-AppsScript'
      },
      muteHttpExceptions: true
    });
    if (getRes.getResponseCode() === 200) {
      const existingData = JSON.parse(getRes.getContentText());
      sha = existingData.sha;
    }
  } catch (e) {
    // 신규 생성 시 무시
  }

  // 2) PUT 요청으로 파일 커밋 & 푸시
  const payload = {
    message: commitMessage,
    content: Utilities.base64Encode(fileContentStr, Utilities.Charset.UTF_8),
    branch: 'main'
  };
  if (sha) payload.sha = sha;

  const putRes = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DailyTest-AppsScript'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const statusCode = putRes.getResponseCode();
  if (statusCode === 200 || statusCode === 201) {
    Logger.log('[성공] GitHub 커밋 성공: ' + filePath);
  } else {
    Logger.log('[경고] GitHub 커밋 실패 (' + statusCode + '): ' + putRes.getContentText());
  }
}

/** data/manifest.json에 새로운 출제 일자 자동 등록 */
function updateManifestOnGitHub_(newDate) {
  const token = PropertiesService.getScriptProperties().getProperty(APP_CONFIG.KEYS.GITHUB_TOKEN);
  if (!token) return;

  const url = 'https://api.github.com/repos/' + APP_CONFIG.GITHUB_REPO + '/contents/data/manifest.json';
  let sha = null;
  let manifest = { dates: [newDate], latest: newDate };
  let needsCommit = false;

  try {
    const getRes = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DailyTest-AppsScript'
      },
      muteHttpExceptions: true
    });
    if (getRes.getResponseCode() === 200) {
      const data = JSON.parse(getRes.getContentText());
      sha = data.sha;
      const decoded = Utilities.newBlob(Utilities.base64Decode(data.content)).getDataAsString();
      manifest = JSON.parse(decoded);
      if (!Array.isArray(manifest.dates)) manifest.dates = [];
      if (manifest.dates.indexOf(newDate) === -1) {
        manifest.dates.push(newDate);
        manifest.dates.sort();
        needsCommit = true;
      }
      if (manifest.latest !== newDate) {
        manifest.latest = newDate;
        needsCommit = true;
      }
    } else {
      needsCommit = true;
    }
  } catch (e) {
    Logger.log('Manifest 조회 에러: ' + e);
    needsCommit = true;
  }

  if (needsCommit) {
    commitFileToGitHub_('data/manifest.json', JSON.stringify(manifest, null, 2), 'chore: update manifest index for ' + newDate);
  } else {
    Logger.log('[정보] Manifest에 이미 ' + newDate + '가 최신으로 등록되어 있어 커밋을 건너뜁니다.');
  }
}
