/**
 * SKCT-style CT Daily Test add-on for the existing TOEIC Slack bot.
 *
 * 설치 방법
 * 1) Apps Script 프로젝트에 이 파일을 ct.gs라는 이름으로 추가합니다.
 * 2) 기존 Code.gs의 doPost(e)에서 payload = JSON.parse(e.parameter.payload);
 *    바로 다음에 아래 두 줄을 추가합니다.
 *
 *      const ctResponse = routeCtInteraction_(payload);
 *      if (ctResponse) return ctResponse;
 *
 * 3) installAllDailyTriggers()를 한 번 실행합니다.
 *    - 오전 7시: 기존 TOEIC
 *    - 오전 8시: CT
 * 4) 먼저 testCtFullRun()으로 생성/저장/Slack 전송을 시험합니다.
 *
 * 현재 CT 모델은 테스트용 gemini-3.5-flash이며, 429/5xx가 발생하면
 * gemini-3.5-flash-lite로 자동 대체됩니다. 운영 시 MODEL만
 * gemini-3.6-flash로 바꾸면 됩니다.
 */

const CT_CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  MODEL: 'gemini-3.6-flash',
  FALLBACK_MODEL: 'gemini-3.5-flash-lite',
  TARGET_DIFFICULTY: 'SKCT-style intermediate to advanced',
  QUESTION_COUNT: 8,
  MAX_ATTEMPTS: 2,
  MAX_OUTPUT_TOKENS: 30000,
  MIN_API_INTERVAL_MS: 20000,
  RETRY_BASE_DELAY_MS: 20000,
  RETRY_JITTER_MS: 5000,
  QUIZ_PREFIX: 'CT_QUIZ_',
  SUBMISSION_PREFIX: 'CT_SUBMISSION_',
  META_KEY: 'CT_QUIZ_META',
  HISTORY_KEY: 'CT_RECENT_THEMES',
  LAST_CALL_KEY: 'LAST_GEMINI_CALL_MS',
  MAX_PROPERTY_BYTES: 8500,
  MAX_SCENARIO_LENGTH: 1800,
  MAX_OPTION_LENGTH: 65
});

const CT_TYPE_LABELS = Object.freeze({
  verbal_logic: '언어논리',
  data_interpretation: '자료해석',
  quantitative_reasoning: '수리응용',
  deductive_reasoning: '논리추리'
});

/** 기존 TOEIC 7시, CT 8시 트리거를 한 번에 다시 설치합니다. */
function installAllDailyTriggers() {
  const handlers = {
    sendDailyToeicTest: true,
    sendDailyCtTest: true
  };

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers[trigger.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('sendDailyToeicTest')
    .timeBased()
    .atHour(7)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(CT_CONFIG.TIME_ZONE)
    .create();

  ScriptApp
    .newTrigger('sendDailyCtTest')
    .timeBased()
    .atHour(8)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(CT_CONFIG.TIME_ZONE)
    .create();

  Logger.log('TOEIC 오전 7시, CT 오전 8시(KST) 트리거를 설치했습니다.');
}

/** 매일 CT 문제를 생성하고 같은 Slack 채널에 별도 블록으로 전송합니다. */
function sendDailyCtTest() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    const settings = getSettings_();
    const date = Utilities.formatDate(
      new Date(),
      CT_CONFIG.TIME_ZONE,
      'yyyy-MM-dd'
    );

    const quiz = generateDailyCtQuiz_(settings.geminiKey, date);

    validateCtQuiz_(quiz);
    storeCtQuiz_(quiz);
    postCtLauncher_(settings.webhookUrl, quiz);
    rememberCtThemes_(quiz);

    Logger.log(
      'CT 테스트가 전송되었습니다: ' +
      date +
      ' / model=' +
      quiz.model
    );
  } catch (error) {
    const message = error && error.stack
      ? error.stack
      : String(error);

    Logger.log(message);
    notifyCtFailureSafely_(message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function testCtFullRun() {
  sendDailyCtTest();
}

/**
 * 기존 doPost의 JSON 파싱 직후 호출되는 CT 전용 라우터입니다.
 * TOEIC 이벤트가 아니면 null을 반환하므로 기존 처리를 방해하지 않습니다.
 */
function routeCtInteraction_(payload) {
  if (
    payload.type === 'view_submission' &&
    payload.view &&
    payload.view.callback_id === 'ct_quiz_submit'
  ) {
    return handleCtQuizSubmission_(payload);
  }

  if (payload.type !== 'block_actions') {
    return null;
  }

  const action = payload.actions && payload.actions[0];

  if (!action) {
    return null;
  }

  if (action.action_id === 'open_ct_quiz') {
    openCtQuizModal_(payload.trigger_id);
    return textOutput_('');
  }

  if (
    action.action_id === 'show_ct_all_explanations' ||
    action.action_id === 'show_ct_wrong_explanations'
  ) {
    updateCtResultsModal_(
      payload,
      action.action_id === 'show_ct_wrong_explanations'
    );
    return textOutput_('');
  }

  if (action.action_id === 'back_to_ct_score') {
    updateCtScoreModal_(payload);
    return textOutput_('');
  }

  return null;
}

function generateDailyCtQuiz_(apiKey, date) {
  const recent = getRecentCtThemes_();
  let feedback = '';
  let lastError = '';

  for (
    let attempt = 1;
    attempt <= CT_CONFIG.MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const prompt = buildCtPrompt_(date, recent, feedback);
      const generated = callCtGeminiJson_(apiKey, prompt);
      const result = generated.data;

      if (!result || !Array.isArray(result.questions)) {
        throw new Error('CT questions 없음');
      }

      setQuestionIds_(result.questions, 'CT');

      const quiz = {
        testId: 'CT' + date.replace(/-/g, ''),
        date: date,
        model: generated.model,
        questions: result.questions
      };

      validateCtQuiz_(quiz);
      return quiz;
    } catch (error) {
      lastError = error.message || String(error);

      Logger.log(
        'CT 생성 실패 ' +
        attempt +
        '/' +
        CT_CONFIG.MAX_ATTEMPTS +
        ': ' +
        lastError
      );

      const temporary = /^Gemini CT HTTP (429|5\d\d):/.test(lastError);

      if (temporary) {
        feedback = '';
      } else {
        feedback = [
          '',
          'PREVIOUS OUTPUT VALIDATION FAILURE:',
          lastError.slice(0, 900),
          'Regenerate all eight questions from scratch.',
          'Return only one corrected final JSON object.'
        ].join('\n');
      }

      if (attempt < CT_CONFIG.MAX_ATTEMPTS) {
        const waitMs =
          CT_CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) +
          Math.floor(Math.random() * CT_CONFIG.RETRY_JITTER_MS);

        Utilities.sleep(waitMs);
      }
    }
  }

  throw new Error('CT 생성이 반복 실패했습니다: ' + lastError);
}

/** 3.5 Flash 실패 시 3.5 Flash Lite로 자동 대체합니다. */
function callCtGeminiJson_(apiKey, prompt) {
  const models = [
    CT_CONFIG.MODEL,
    CT_CONFIG.FALLBACK_MODEL
  ].filter(function (model, index, array) {
    return model && array.indexOf(model) === index;
  });

  let lastError = null;

  for (let index = 0; index < models.length; index++) {
    const model = models[index];

    try {
      return {
        data: callCtModelJson_(apiKey, prompt, model),
        model: model
      };
    } catch (error) {
      lastError = error;
      const message = error.message || String(error);
      const canFallback = /^Gemini CT HTTP (429|5\d\d):/.test(message);

      Logger.log('CT 모델 ' + model + ' 실패: ' + message);

      if (!canFallback || index === models.length - 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error('사용 가능한 CT 모델이 없습니다.');
}

function callCtModelJson_(apiKey, prompt, model) {
  waitForCtRateSlot_();

  const endpoint =
    'https://generativelanguage.googleapis.com/' +
    'v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const requestPayload = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.55,
      topP: 0.9,
      maxOutputTokens: CT_CONFIG.MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json'
    }
  };

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(requestPayload)
  });

  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(
      'Gemini CT HTTP ' +
      responseCode +
      ': ' +
      responseText.slice(0, 1000)
    );
  }

  let envelope;

  try {
    envelope = JSON.parse(responseText);
  } catch (error) {
    throw new Error('Gemini CT 응답 envelope 파싱 실패');
  }

  const candidate = envelope.candidates && envelope.candidates[0];

  if (!candidate) {
    throw new Error('Gemini CT candidate 없음');
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini CT 출력이 MAX_TOKENS로 잘렸습니다.');
  }

  const parts = candidate.content && candidate.content.parts;
  const generatedText = parts
    ? parts.map(function (part) {
        return part.text || '';
      }).join('')
    : '';

  if (!generatedText.trim()) {
    throw new Error('Gemini CT 빈 응답');
  }

  try {
    const cleanText = generatedText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    return JSON.parse(cleanText);
  } catch (error) {
    throw new Error(
      'Gemini CT JSON 본문 파싱 실패: ' +
      generatedText.slice(0, 700)
    );
  }
}

function waitForCtRateSlot_() {
  const properties = PropertiesService.getScriptProperties();
  const lastCall = Number(
    properties.getProperty(CT_CONFIG.LAST_CALL_KEY) || 0
  );
  const waitTime = CT_CONFIG.MIN_API_INTERVAL_MS - (Date.now() - lastCall);

  if (waitTime > 0) {
    Utilities.sleep(waitTime);
  }

  properties.setProperty(
    CT_CONFIG.LAST_CALL_KEY,
    String(Date.now())
  );
}

function buildCtPrompt_(date, recent, feedback) {
  const lines = [
    'You are a professional Korean cognitive-aptitude test item writer.',
    'Create original SKCT-style practice items, not official SKCT questions.',
    'Date: ' + date,
    'Target difficulty: ' + CT_CONFIG.TARGET_DIFFICULTY + '.',
    'Write all user-visible content in natural Korean.',
    'Do not copy, paraphrase, reconstruct, or search for published test items.',
    'Do not require outside knowledge.',
    '',
    'OUTPUT CONTRACT:',
    'Return exactly one valid JSON object and nothing else.',
    'The root object must be {"questions": [...]}.',
    'Create exactly 8 questions.',
    'Do not use Markdown fences, XML, comments, drafts, or reasoning notes.',
    '',
    'QUESTION SCHEMA:',
    'questionType: one allowed value below',
    'difficulty: "medium" or "hard"',
    'scenario: all information needed to solve the item, in Korean',
    'question: the exact question, in Korean',
    'options: exactly 4 Korean strings',
    'answerIndex: integer 0-3',
    'explanation: detailed Korean solution',
    'optionExplanations: exactly 4 Korean strings',
    'estimatedSeconds: integer 45-240',
    '',
    'TYPE DISTRIBUTION:',
    '"verbal_logic": exactly 2',
    '"data_interpretation": exactly 2',
    '"quantitative_reasoning": exactly 2',
    '"deductive_reasoning": exactly 2',
    'For every questionType, create exactly one medium and one hard item.',
    '',
    'TYPE RULES:',
    'verbal_logic: test statement relationships, conclusions, assumptions, or ordering from text.',
    'data_interpretation: include a compact self-contained table or numerical dataset in scenario.',
    'quantitative_reasoning: use rates, ratios, percentages, work, distance, allocation, or applied arithmetic.',
    'deductive_reasoning: use ordering, grouping, scheduling, conditional rules, or must-be-true reasoning.',
    '',
    'QUALITY AND VALIDATION RULES:',
    'Every item must have exactly one defensible answer.',
    'All required facts, units, and conditions must appear in scenario.',
    'Never use subjective judgment, personality assessment, or company-culture preference.',
    'Avoid ambiguous pronouns, unstated assumptions, and multiple valid interpretations.',
    'All four options must be plausible and 65 characters or fewer.',
    'Use consistent units and specify rounding whenever needed.',
    'For numeric items, independently recompute the correct value before returning.',
    'For logic items, enumerate or test all relevant cases before returning.',
    'For must-be-true questions, verify the answer across every valid case.',
    'For could-be-true questions, verify at least one valid case and reject the other options.',
    'The explanation must show enough steps for a learner to reproduce the answer.',
    'Each optionExplanation must explain that specific option.',
    'Distribute answerIndex values without an obvious pattern.',
    'Do not use the same answerIndex three times consecutively.',
    '',
    'Avoid recent themes or near-duplicate setups:',
    recent.length ? recent.join(' | ') : 'none',
    '',
    'Before returning, silently solve every item again and replace any failed item.',
    'Return only the polished final JSON object.'
  ];

  if (feedback) {
    lines.push(feedback);
  }

  return lines.join('\n');
}

function validateCtQuiz_(quiz) {
  if (!quiz || !Array.isArray(quiz.questions)) {
    throw new Error('CT questions 없음');
  }

  if (quiz.questions.length !== CT_CONFIG.QUESTION_COUNT) {
    throw new Error('CT 문항 수 오류: ' + quiz.questions.length);
  }

  const expectedTypes = {
    verbal_logic: 2,
    data_interpretation: 2,
    quantitative_reasoning: 2,
    deductive_reasoning: 2
  };

  const typeCounts = {};
  const difficultyCounts = {
    medium: 0,
    hard: 0
  };
  const typeDifficultyCounts = {};
  const questionKeys = {};
  const answers = [];

  quiz.questions.forEach(function (question, index) {
    const number = index + 1;

    if (!expectedTypes.hasOwnProperty(question.questionType)) {
      throw new Error(
        'CT ' + number + '번 questionType 오류: ' +
        String(question.questionType)
      );
    }

    if (!difficultyCounts.hasOwnProperty(question.difficulty)) {
      throw new Error(
        'CT ' + number + '번 difficulty 오류: ' +
        String(question.difficulty)
      );
    }

    const scenario = String(question.scenario || '').trim();
    const questionText = String(question.question || '').trim();

    if (scenario.length < 20 || scenario.length > CT_CONFIG.MAX_SCENARIO_LENGTH) {
      throw new Error(
        'CT ' + number + '번 scenario 길이 오류: ' + scenario.length
      );
    }

    if (questionText.length < 5 || questionText.length > 400) {
      throw new Error(
        'CT ' + number + '번 question 길이 오류: ' + questionText.length
      );
    }

    if (!containsKorean_(scenario) || !containsKorean_(questionText)) {
      throw new Error('CT ' + number + '번 한국어 문제 형식 오류');
    }

    if (!Array.isArray(question.options) || question.options.length !== 4) {
      throw new Error('CT ' + number + '번 선택지 형식 오류');
    }

    const optionKeys = {};

    question.options.forEach(function (option) {
      const optionText = String(option || '').trim();

      if (!optionText || optionText.length > CT_CONFIG.MAX_OPTION_LENGTH) {
        throw new Error('CT ' + number + '번 선택지 길이 오류');
      }

      const key = normalizeText_(optionText);

      if (optionKeys[key]) {
        throw new Error('CT ' + number + '번 중복 선택지 발견');
      }

      optionKeys[key] = true;
    });

    if (
      !Number.isInteger(question.answerIndex) ||
      question.answerIndex < 0 ||
      question.answerIndex > 3
    ) {
      throw new Error('CT ' + number + '번 정답 인덱스 오류');
    }

    if (
      !question.explanation ||
      !containsKorean_(question.explanation)
    ) {
      throw new Error('CT ' + number + '번 핵심 해설 오류');
    }

    if (
      !Array.isArray(question.optionExplanations) ||
      question.optionExplanations.length !== 4 ||
      question.optionExplanations.some(function (explanation) {
        return !explanation || !containsKorean_(explanation);
      })
    ) {
      throw new Error('CT ' + number + '번 선택지별 해설 오류');
    }

    if (
      !Number.isInteger(question.estimatedSeconds) ||
      question.estimatedSeconds < 45 ||
      question.estimatedSeconds > 240
    ) {
      throw new Error('CT ' + number + '번 예상 시간 오류');
    }

    const questionKey = normalizeText_(scenario + ' ' + questionText);

    if (questionKeys[questionKey]) {
      throw new Error('CT 중복 문제 발견');
    }

    questionKeys[questionKey] = true;
    answers.push(question.answerIndex);

    typeCounts[question.questionType] =
      (typeCounts[question.questionType] || 0) + 1;
    difficultyCounts[question.difficulty]++;

    if (!typeDifficultyCounts[question.questionType]) {
      typeDifficultyCounts[question.questionType] = {
        medium: 0,
        hard: 0
      };
    }

    typeDifficultyCounts[question.questionType][question.difficulty]++;
  });

  Object.keys(expectedTypes).forEach(function (type) {
    if ((typeCounts[type] || 0) !== expectedTypes[type]) {
      throw new Error(
        'CT 유형 구성 오류: ' + type + '=' + (typeCounts[type] || 0)
      );
    }

    if (
      !typeDifficultyCounts[type] ||
      typeDifficultyCounts[type].medium !== 1 ||
      typeDifficultyCounts[type].hard !== 1
    ) {
      throw new Error('CT 유형별 난이도 구성 오류: ' + type);
    }
  });

  if (difficultyCounts.medium !== 4 || difficultyCounts.hard !== 4) {
    throw new Error(
      'CT 전체 난이도 구성 오류: medium=' +
      difficultyCounts.medium +
      ', hard=' +
      difficultyCounts.hard
    );
  }

  for (let index = 2; index < answers.length; index++) {
    if (
      answers[index] === answers[index - 1] &&
      answers[index] === answers[index - 2]
    ) {
      throw new Error('CT 동일 정답 인덱스 3회 연속');
    }
  }
}

function storeCtQuiz_(quiz) {
  const properties = PropertiesService.getScriptProperties();
  const allProperties = properties.getProperties();

  Object.keys(allProperties).forEach(function (key) {
    if (
      key.indexOf(CT_CONFIG.QUIZ_PREFIX) === 0 ||
      key.indexOf(CT_CONFIG.SUBMISSION_PREFIX) === 0 ||
      key === CT_CONFIG.META_KEY
    ) {
      properties.deleteProperty(key);
    }
  });

  const entries = {};
  const meta = {
    testId: quiz.testId,
    date: quiz.date,
    model: quiz.model,
    questionIds: quiz.questions.map(function (question) {
      return question.id;
    })
  };

  entries[CT_CONFIG.META_KEY] = JSON.stringify(meta);

  quiz.questions.forEach(function (question, index) {
    const key =
      CT_CONFIG.QUIZ_PREFIX +
      quiz.testId +
      '_' +
      question.id;

    entries[key] = JSON.stringify({
      id: question.id,
      number: index + 1,
      questionType: question.questionType,
      difficulty: question.difficulty,
      scenario: question.scenario,
      question: question.question,
      options: question.options,
      answerIndex: question.answerIndex,
      explanation: question.explanation,
      optionExplanations: question.optionExplanations,
      estimatedSeconds: question.estimatedSeconds
    });
  });

  Object.keys(entries).forEach(function (key) {
    const bytes = Utilities.newBlob(entries[key]).getBytes().length;

    if (bytes > CT_CONFIG.MAX_PROPERTY_BYTES) {
      throw new Error(key + ' 데이터가 너무 큽니다: ' + bytes);
    }
  });

  properties.setProperties(entries, false);
}

function loadCtQuiz_() {
  const properties = PropertiesService.getScriptProperties();
  const metaText = properties.getProperty(CT_CONFIG.META_KEY);

  if (!metaText) {
    throw new Error('저장된 오늘의 CT 문제가 없습니다.');
  }

  const meta = JSON.parse(metaText);
  const questions = meta.questionIds.map(function (id) {
    const text = properties.getProperty(
      CT_CONFIG.QUIZ_PREFIX + meta.testId + '_' + id
    );

    if (!text) {
      throw new Error(id + ' CT 문제 데이터가 없습니다.');
    }

    return JSON.parse(text);
  });

  return {
    testId: meta.testId,
    date: meta.date,
    model: meta.model,
    questions: questions
  };
}

function postCtLauncher_(webhookUrl, quiz) {
  postSlack_(webhookUrl, {
    text: 'SKCT-style CT Daily Test — ' + quiz.date,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🧠 CT Daily Test',
          emoji: true
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '*' + quiz.date + '* · 총 8문항 · 예상 12분'
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*테스트 구성*\n' +
            '• 언어논리 2문항\n' +
            '• 자료해석 2문항\n' +
            '• 수리응용 2문항\n' +
            '• 논리추리 2문항'
        }
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '제출 시 *점수, 오답 해설, 선택지별 분석* 확인 가능.\n' +
            '_공식 기출이 아닌 AI 생성 유형 연습문제입니다._'
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              '🤖 AI 생성 모델: `' +
              escapeSlack_(quiz.model) +
              '` · 난이도: `중상~상`'
          }
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            action_id: 'open_ct_quiz',
            text: {
              type: 'plain_text',
              text: 'Daily CT 풀기',
              emoji: true
            },
            value: quiz.testId
          }
        ]
      }
    ]
  });
}

function openCtQuizModal_(triggerId) {
  const quiz = loadCtQuiz_();

  callSlackApi_('views.open', {
    trigger_id: triggerId,
    view: buildCtQuizView_(quiz)
  });
}

function buildCtQuizView_(quiz) {
  const blocks = [
    section_(
      '*' +
      quiz.date +
      '*\n8문제를 모두 선택한 뒤 답안을 제출하세요.'
    )
  ];

  quiz.questions.forEach(function (question) {
    blocks.push({
      type: 'divider'
    });

    blocks.push(
      section_(
        '*' +
        question.number +
        '번 · ' +
        CT_TYPE_LABELS[question.questionType] +
        ' · ' +
        (question.difficulty === 'hard' ? '상' : '중') +
        '*'
      )
    );

    addSectionChunks_(blocks, escapeSlack_(question.scenario));

    blocks.push({
      type: 'input',
      block_id: question.id,
      label: {
        type: 'plain_text',
        text: question.question
      },
      element: {
        type: 'radio_buttons',
        action_id: 'answer',
        options: question.options.map(function (option, index) {
          return {
            text: {
              type: 'plain_text',
              text: '(' + ['A', 'B', 'C', 'D'][index] + ') ' + option
            },
            value: String(index)
          };
        })
      }
    });
  });

  if (blocks.length > 100) {
    throw new Error('CT 문제 Modal 블록 수가 100개를 초과했습니다.');
  }

  return {
    type: 'modal',
    callback_id: 'ct_quiz_submit',
    private_metadata: quiz.testId,
    title: {
      type: 'plain_text',
      text: 'CT Daily Test'
    },
    submit: {
      type: 'plain_text',
      text: '답안 제출'
    },
    close: {
      type: 'plain_text',
      text: '취소'
    },
    blocks: blocks
  };
}

function handleCtQuizSubmission_(payload) {
  const quiz = loadCtQuiz_();

  if (payload.view.private_metadata !== quiz.testId) {
    return jsonOutput_({
      response_action: 'errors',
      errors: {
        CTQ1: '새 CT 문제가 등록되었습니다. 창을 받고 다시 시작해주세요.'
      }
    });
  }

  const state = payload.view.state.values;
  const answers = {};

  quiz.questions.forEach(function (question) {
    const selected =
      state[question.id] &&
      state[question.id].answer &&
      state[question.id].answer.selected_option;

    if (!selected) {
      throw new Error(question.id + ' 선택 답안 없음');
    }

    answers[question.id] = Number(selected.value);
  });

  const submission = gradeCt_(quiz, answers);
  submission.userId = payload.user.id;
  storeCtSubmission_(quiz.testId, submission);

  return jsonOutput_({
    response_action: 'update',
    view: buildCtScoreView_(quiz, submission)
  });
}

function gradeCt_(quiz, answers) {
  const result = {
    answers: answers,
    correct: 0,
    total: quiz.questions.length,
    types: {}
  };

  Object.keys(CT_TYPE_LABELS).forEach(function (type) {
    result.types[type] = {
      correct: 0,
      total: 0
    };
  });

  quiz.questions.forEach(function (question) {
    result.types[question.questionType].total++;

    if (answers[question.id] === question.answerIndex) {
      result.correct++;
      result.types[question.questionType].correct++;
    }
  });

  return result;
}

function storeCtSubmission_(testId, submission) {
  const key =
    CT_CONFIG.SUBMISSION_PREFIX +
    testId +
    '_' +
    submission.userId;

  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify(submission)
  );
}

function loadCtSubmission_(testId, userId) {
  const key = CT_CONFIG.SUBMISSION_PREFIX + testId + '_' + userId;
  const text = PropertiesService.getScriptProperties().getProperty(key);

  if (!text) {
    throw new Error('CT 제출 기록이 없습니다.');
  }

  return JSON.parse(text);
}

function buildCtScoreView_(quiz, submission) {
  const percentage = Math.round(
    submission.correct / submission.total * 1000
  ) / 10;

  const typeLines = Object.keys(CT_TYPE_LABELS).map(function (type) {
    return (
      CT_TYPE_LABELS[type] +
      ': ' +
      submission.types[type].correct +
      ' / ' +
      submission.types[type].total
    );
  });

  return {
    type: 'modal',
    callback_id: 'ct_score',
    private_metadata: quiz.testId,
    title: {
      type: 'plain_text',
      text: 'CT 채점 결과'
    },
    close: {
      type: 'plain_text',
      text: '닫기'
    },
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🎉 CT 채점 완료',
          emoji: true
        }
      },
      section_(
        '*총점: ' +
        submission.correct +
        ' / ' +
        submission.total +
        '* · 정답률 ' +
        percentage +
        '%\n\n' +
        typeLines.join('\n')
      ),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            action_id: 'show_ct_all_explanations',
            text: {
              type: 'plain_text',
              text: '전체 해설 보기'
            },
            value: quiz.testId
          },
          {
            type: 'button',
            action_id: 'show_ct_wrong_explanations',
            text: {
              type: 'plain_text',
              text: '틀린 문제만 보기'
            },
            value: quiz.testId
          }
        ]
      }
    ]
  };
}

function updateCtResultsModal_(payload, wrongOnly) {
  const quiz = loadCtQuiz_();
  const submission = loadCtSubmission_(quiz.testId, payload.user.id);

  callSlackApi_('views.update', {
    view_id: payload.view.id,
    hash: payload.view.hash,
    view: buildCtExplanationView_(quiz, submission, wrongOnly)
  });
}

function updateCtScoreModal_(payload) {
  const quiz = loadCtQuiz_();
  const submission = loadCtSubmission_(quiz.testId, payload.user.id);

  callSlackApi_('views.update', {
    view_id: payload.view.id,
    hash: payload.view.hash,
    view: buildCtScoreView_(quiz, submission)
  });
}

function buildCtExplanationView_(quiz, submission, wrongOnly) {
  const blocks = [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'back_to_ct_score',
          text: {
            type: 'plain_text',
            text: '← 점수로 돌아가기'
          },
          value: quiz.testId
        }
      ]
    }
  ];

  const questions = quiz.questions.filter(function (question) {
    return (
      !wrongOnly ||
      submission.answers[question.id] !== question.answerIndex
    );
  });

  if (!questions.length) {
    blocks.push(section_('*모든 CT 문제를 맞혔습니다! 🎉*'));
  }

  questions.forEach(function (question) {
    blocks.push({
      type: 'divider'
    });

    addSectionChunks_(
      blocks,
      ctExplanationText_(
        question,
        submission.answers[question.id]
      )
    );
  });

  if (blocks.length > 100) {
    throw new Error('CT 해설 Modal 블록 수가 100개를 초과했습니다.');
  }

  return {
    type: 'modal',
    callback_id: 'ct_explanations',
    private_metadata: quiz.testId,
    title: {
      type: 'plain_text',
      text: wrongOnly ? 'CT 오답 해설' : 'CT 전체 해설'
    },
    close: {
      type: 'plain_text',
      text: '닫기'
    },
    blocks: blocks
  };
}

function ctExplanationText_(question, selectedIndex) {
  const labels = ['A', 'B', 'C', 'D'];
  const isCorrect = selectedIndex === question.answerIndex;
  const lines = [
    '*' +
      question.number +
      '번 · ' +
      CT_TYPE_LABELS[question.questionType] +
      ' · ' +
      (isCorrect ? '✅ 정답' : '❌ 오답') +
      '*',
    '',
    '*조건*',
    escapeSlack_(question.scenario),
    '',
    '*' + escapeSlack_(question.question) + '*',
    '',
    '내 선택: *(' +
      labels[selectedIndex] +
      ')* ' +
      escapeSlack_(question.options[selectedIndex]),
    '정답: *(' +
      labels[question.answerIndex] +
      ')* ' +
      escapeSlack_(question.options[question.answerIndex]),
    '',
    '*핵심 해설*',
    escapeSlack_(question.explanation),
    '',
    '*선택지 해설*'
  ];

  question.optionExplanations.forEach(function (explanation, index) {
    lines.push(
      '(' + labels[index] + ') ' + escapeSlack_(explanation)
    );
  });

  return lines.join('\n');
}

function getRecentCtThemes_() {
  try {
    return JSON.parse(
      PropertiesService.getScriptProperties().getProperty(
        CT_CONFIG.HISTORY_KEY
      ) || '[]'
    );
  } catch (error) {
    return [];
  }
}

function rememberCtThemes_(quiz) {
  const properties =
    PropertiesService.getScriptProperties();

  const history =
    getRecentCtThemes_();

  const summary =
    quiz.questions.map(
      function (question) {
        return (
          question.questionType +
          ': ' +
          String(
            question.scenario || ''
          )
            .replace(/\s+/g, ' ')
            .slice(0, 90)
        );
      }
    ).join(' | ');

  history.unshift(summary);

  const trimmedHistory =
    history.slice(0, 14);

  while (
    trimmedHistory.length > 1 &&
    Utilities
      .newBlob(
        JSON.stringify(
          trimmedHistory
        )
      )
      .getBytes()
      .length >
      CT_CONFIG.MAX_PROPERTY_BYTES
  ) {
    trimmedHistory.pop();
  }

  properties.setProperty(
    CT_CONFIG.HISTORY_KEY,
    JSON.stringify(
      trimmedHistory
    )
  );
}

function notifyCtFailureSafely_(message) {
  try {
    const webhookUrl = PropertiesService
      .getScriptProperties()
      .getProperty('SLACK_WEBHOOK_URL');

    if (webhookUrl) {
      postSlack_(webhookUrl, {
        text:
          '*:warning: CT Bot 실패*\n```' +
          message.slice(0, 2000) +
          '```'
      });
    }
  } catch (error) {
    Logger.log('CT 오류 알림도 실패: ' + error);
  }
}
