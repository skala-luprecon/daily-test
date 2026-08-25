/** TOEIC RC Daily Test - Slack Modal edition */

const CONFIG = Object.freeze({
  TIME_ZONE: 'Asia/Seoul',
  MODEL: 'gemini-3.6-flash',
  TARGET_DIFFICULTY: 'TOEIC 750-950',
  MAX_ATTEMPTS: 3,
  MAX_OUTPUT_TOKENS: 20000,
  MIN_API_INTERVAL_MS: 20000,
  RETRY_BASE_DELAY_MS: 20000,
  RETRY_JITTER_MS: 5000,
  QUIZ_PREFIX: 'QUIZ_',
  SUBMISSION_PREFIX: 'SUBMISSION_',
  META_KEY: 'QUIZ_META',
  HISTORY_KEY: 'TOEIC_RECENT_THEMES',
  LAST_CALL_KEY: 'LAST_GEMINI_CALL_MS',
  MAX_PROPERTY_BYTES: 8500,
  MAX_SECTION_LENGTH: 2900
});

function installDailyTrigger() {
  const targetHandlers = {
    sendDailyToeicTest: true,
    sendDailyCtTest: true
  };

  ScriptApp
    .getProjectTriggers()
    .forEach(function (trigger) {
      if (
        targetHandlers[
          trigger.getHandlerFunction()
        ]
      ) {
        ScriptApp.deleteTrigger(trigger);
      }
    });

  ScriptApp
    .newTrigger('sendDailyToeicTest')
    .timeBased()
    .atHour(7)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(CONFIG.TIME_ZONE)
    .create();

  ScriptApp
    .newTrigger('sendDailyCtTest')
    .timeBased()
    .atHour(8)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(CONFIG.TIME_ZONE)
    .create();

  Logger.log(
    'TOEIC 오전 7시, CT 오전 8시(KST) ' +
    '트리거가 설치되었습니다.'
  );
}


function createInteractionSecret() {
  const properties =
    PropertiesService.getScriptProperties();

  let secret =
    properties.getProperty(
      'SLACK_INTERACTION_SECRET'
    );

  if (!secret) {
    secret =
      Utilities
        .getUuid()
        .replace(/-/g, '') +
      Utilities
        .getUuid()
        .replace(/-/g, '');

    properties.setProperty(
      'SLACK_INTERACTION_SECRET',
      secret
    );
  }

  Logger.log(
    'Request URL 뒤에 붙일 값: ?secret=' +
    secret
  );
}

function sendDailyToeicTest() {
  const lock =
    LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    const settings = getSettings_();

    const date =
      Utilities.formatDate(
        new Date(),
        CONFIG.TIME_ZONE,
        'yyyy-MM-dd'
      );

    const quiz =
      generateDailyQuiz_(
        settings.geminiKey,
        date
      );

    validateQuiz_(quiz);
    storeQuiz_(quiz);

    postLauncher_(
      settings.webhookUrl,
      quiz
    );

    rememberThemes_(quiz);

    Logger.log(
      'Modal형 토익 테스트가 전송되었습니다: ' +
      date
    );
  } catch (error) {
    const message =
      error && error.stack
        ? error.stack
        : String(error);

    Logger.log(message);
    notifyFailureSafely_(message);

    throw error;
  } finally {
    lock.releaseLock();
  }
}

function testSlackWebhook() {
  const settings = getSettings_();

  postSlack_(
    settings.webhookUrl,
    {
      text:
        '*TOEIC Daily Bot 연결 성공* ' +
        ':white_check_mark:'
    }
  );
}

function testFullRun() {
  sendDailyToeicTest();
}

function doGet() {
  return ContentService
    .createTextOutput(
      'TOEIC Daily Bot is running.'
    );
}

function doPost(e) {
  let payload = null;

  try {
    verifyInteractionSecret_(e);

    if (!e.parameter.payload) {
      return textOutput_('ok');
    }

    payload =
      JSON.parse(e.parameter.payload);

    // CT.gs가 처리할 이벤트라면 여기서 응답하고,
    // TOEIC 이벤트라면 null을 받아 기존 로직으로 진행합니다.
    const ctResponse =
      routeCtInteraction_(payload);

    if (ctResponse) {
      return ctResponse;
    }

    if (
      payload.type ===
        'view_submission' &&
      payload.view.callback_id ===
        'toeic_quiz_submit'
    ) {
      return handleQuizSubmission_(
        payload
      );
    }

    if (
      payload.type ===
      'block_actions'
    ) {
      const action =
        payload.actions &&
        payload.actions[0];

      if (!action) {
        return textOutput_('ok');
      }

      if (
        action.action_id ===
        'open_toeic_quiz'
      ) {
        openQuizModal_(
          payload.trigger_id
        );

        return textOutput_('');
      }

      if (
        action.action_id ===
          'show_all_explanations' ||
        action.action_id ===
          'show_wrong_explanations'
      ) {
        const wrongOnly =
          action.action_id ===
          'show_wrong_explanations';

        updateResultsModal_(
          payload,
          wrongOnly
        );

        return textOutput_('');
      }

      if (
        action.action_id ===
        'back_to_score'
      ) {
        updateScoreModal_(payload);

        return textOutput_('');
      }
    }

    return textOutput_('ok');
  } catch (error) {
    Logger.log(
      error && error.stack
        ? error.stack
        : String(error)
    );

    if (
      payload &&
      payload.response_url
    ) {
      UrlFetchApp.fetch(
        payload.response_url,
        {
          method: 'post',
          contentType:
            'application/json',
          muteHttpExceptions: true,
          payload:
            JSON.stringify({
              text:
                '처리 중 오류가 발생했습니다. ' +
                '잠시 후 다시 시도해주세요.'
            })
        }
      );
    }

    return textOutput_('');
  }
}

function verifyInteractionSecret_(e) {
  const expected =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        'SLACK_INTERACTION_SECRET'
      );

  const provided =
    e && e.parameter
      ? e.parameter.secret
      : '';

  if (
    !expected ||
    provided !== expected
  ) {
    throw new Error(
      'Slack interaction secret 불일치'
    );
  }
}

function getSettings_() {
  const properties =
    PropertiesService
      .getScriptProperties();

  const geminiKey =
    properties.getProperty(
      'GEMINI_API_KEY'
    );

  const webhookUrl =
    properties.getProperty(
      'SLACK_WEBHOOK_URL'
    );

  const botToken =
    properties.getProperty(
      'SLACK_BOT_TOKEN'
    );

  if (!geminiKey) {
    throw new Error(
      'GEMINI_API_KEY가 없습니다.'
    );
  }

  if (!webhookUrl) {
    throw new Error(
      'SLACK_WEBHOOK_URL이 없습니다.'
    );
  }

  if (!botToken) {
    throw new Error(
      'SLACK_BOT_TOKEN이 없습니다.'
    );
  }

  if (!/^xoxb-/.test(botToken)) {
    throw new Error(
      'SLACK_BOT_TOKEN은 xoxb-로 시작해야 합니다.'
    );
  }

  return {
    geminiKey: geminiKey,
    webhookUrl: webhookUrl,
    botToken: botToken
  };
}

function generateDailyQuiz_(
  apiKey,
  date
) {
  const recent =
    getRecentThemes_();

  const part5 =
    generatePart_(
      apiKey,
      'part5',
      date,
      recent
    );

  const part6 =
    generatePart_(
      apiKey,
      'part6',
      date,
      recent
    );

  const part7 =
    generatePart_(
      apiKey,
      'part7',
      date,
      recent
    );

  setQuestionIds_(
    part5.questions,
    'P5'
  );

  setQuestionIds_(
    part6.questions,
    'P6'
  );

  setQuestionIds_(
    part7.questions,
    'P7'
  );

  return {
    testId:
      date.replace(/-/g, ''),
    date: date,
    part5: part5,
    part6: part6,
    part7: part7
  };
}

function generatePart_(
  apiKey,
  partName,
  date,
  recent
) {
  let feedback = '';
  let lastError = '';

  for (
    let attempt = 1;
    attempt <= CONFIG.MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const prompt =
        buildPrompt_(
          partName,
          date,
          recent,
          feedback
        );

      const result =
        callGeminiJson_(
          apiKey,
          prompt
        );

      validatePart_(
        partName,
        result
      );

      return result;
    } catch (error) {
      lastError = error.message;

      Logger.log(
        partName +
        ' 생성 실패 ' +
        attempt +
        '/' +
        CONFIG.MAX_ATTEMPTS +
        ': ' +
        lastError
      );

      const isTemporaryApiError =
        /^Gemini HTTP (429|5\d\d):/.test(
          lastError
        );

      if (isTemporaryApiError) {
        // 429/5xx는 문제 내용이 아니라 API의
        // 일시적 상태이므로 프롬프트를 바꾸지 않는다.
        feedback = '';

        if (
          attempt <
          CONFIG.MAX_ATTEMPTS
        ) {
          const backoffMs =
            CONFIG.RETRY_BASE_DELAY_MS *
            Math.pow(
              2,
              attempt - 1
            );

          const jitterMs =
            Math.floor(
              Math.random() *
              CONFIG.RETRY_JITTER_MS
            );

          const retryWaitMs =
            backoffMs + jitterMs;

          Logger.log(
            partName +
            ' 일시적 API 오류: ' +
            retryWaitMs +
            'ms 후 재시도'
          );

          Utilities.sleep(
            retryWaitMs
          );
        }
      } else {
        // JSON 또는 문제 품질 검증 실패는
        // 구체적인 실패 이유를 다음 생성에 전달한다.
        feedback =
          '\nThe previous output failed validation: ' +
          lastError.slice(0, 800) +
          '\nRegenerate the entire part from scratch. ' +
          'Return only one corrected final JSON object. ' +
          'Do not discuss the error or your correction process.';
      }
    }
  }

  throw new Error(
    partName +
    ' 생성이 반복 실패했습니다: ' +
    lastError
  );
}

function callGeminiJson_(
  apiKey,
  prompt
) {
  waitForRateSlot_();

  const endpoint =
    'https://generativelanguage.googleapis.com/' +
    'v1beta/models/' +
    encodeURIComponent(
      CONFIG.MODEL
    ) +
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
      // 지시 준수와 일관성을 높이되
      // 일일 문제의 다양성은 유지한다.
      temperature: 0.65,
      topP: 0.9,
      maxOutputTokens:
        CONFIG.MAX_OUTPUT_TOKENS,
      responseMimeType:
        'application/json'
    }
  };

  const response =
    UrlFetchApp.fetch(
      endpoint,
      {
        method: 'post',
        contentType:
          'application/json',
        muteHttpExceptions: true,
        payload:
          JSON.stringify(
            requestPayload
          )
      }
    );

  const responseCode =
    response.getResponseCode();

  const responseText =
    response.getContentText();

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      'Gemini HTTP ' +
      responseCode +
      ': ' +
      responseText.slice(
        0,
        1000
      )
    );
  }

  let envelope;

  try {
    envelope =
      JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      'Gemini 응답 파싱 실패'
    );
  }

  const candidate =
    envelope.candidates &&
    envelope.candidates[0];

  if (!candidate) {
    throw new Error(
      'Gemini candidate 없음'
    );
  }

  if (
    candidate.finishReason ===
    'MAX_TOKENS'
  ) {
    throw new Error(
      '출력이 MAX_TOKENS로 잘렸습니다.'
    );
  }

  const parts =
    candidate.content &&
    candidate.content.parts;

  const generatedText = parts
    ? parts
        .map(function (part) {
          return part.text || '';
        })
        .join('')
    : '';

  if (!generatedText.trim()) {
    throw new Error(
      'Gemini 빈 응답'
    );
  }

  try {
    const cleanText =
      generatedText
        .replace(
          /^```(?:json)?\s*/i,
          ''
        )
        .replace(
          /\s*```$/,
          ''
        )
        .trim();

    return JSON.parse(cleanText);
  } catch (error) {
    throw new Error(
      'Gemini JSON 본문 파싱 실패: ' +
      generatedText.slice(
        0,
        700
      )
    );
  }
}

function waitForRateSlot_() {
  const properties =
    PropertiesService
      .getScriptProperties();

  const lastCall =
    Number(
      properties.getProperty(
        CONFIG.LAST_CALL_KEY
      ) || 0
    );

  const elapsed =
    Date.now() - lastCall;

  const waitTime =
    CONFIG.MIN_API_INTERVAL_MS -
    elapsed;

  if (waitTime > 0) {
    Utilities.sleep(waitTime);
  }

  properties.setProperty(
    CONFIG.LAST_CALL_KEY,
    String(Date.now())
  );
}

function buildPrompt_(
  partName,
  date,
  recent,
  feedback
) {
  const lines = [
    'You are a professional TOEIC Reading item writer for Korean learners.',
    'Date: ' + date,
    'Target difficulty: ' +
      CONFIG.TARGET_DIFFICULTY +
      '.',
    'Write entirely original items in realistic workplace and business contexts.',
    'Do not copy or closely imitate published TOEIC questions.',
    'Do not require outside knowledge.',
    '',
    'OUTPUT CONTRACT:',
    'Return exactly one valid JSON object and nothing else.',
    'Do not use Markdown, code fences, XML, comments, or introductory text.',
    'Return only the polished final version.',
    'Never include drafts, self-corrections, notes, reasoning, or commentary.',
    'Never describe how you created, checked, or corrected the content.',
    'Do not restart or repeat a passage inside the output.',
    '',
    'QUALITY RULES:',
    'Use natural contemporary business English.',
    'Each question must have exactly one clearly defensible answer.',
    'All distractors must be plausible in grammar, meaning, or context.',
    'Do not use absurd, nonexistent, or obviously malformed distractors.',
    'Do not depend on tricks, obscure facts, or ambiguous wording.',
    'Distribute answerIndex values without an obvious pattern.',
    'Do not use the same answerIndex more than twice consecutively.',
    'Each option must be 65 characters or fewer for Slack radio buttons.',
    'Korean translations must be natural, accurate, and complete.',
    'Do not omit names, dates, quantities, conditions, or negation in translation.',
    'Every explanation must state the exact grammar rule or passage evidence.',
    'Every optionExplanation must specifically explain its own option.',
    'Do not invent evidence that is absent from the sentence or passage.',
    '',
    'Every question must contain these fields:',
    'questionType: one allowed value specified below',
    'question',
    'options: exactly 4 strings',
    'answerIndex: integer 0-3',
    'questionTranslation: Korean',
    'explanation: detailed Korean',
    'optionExplanations: exactly 4 Korean strings',
    'vocabulary: 2-5 strings',
    '',
    'Vocabulary format:',
    '"word: 뜻 / collocation"',
    'Vocabulary entries must be useful words or collocations from the item.',
    '',
    'Avoid recent themes:',
    recent.length
      ? recent.join(' | ')
      : 'none',
    '',
    'Before returning, silently audit every rule and fix any violation.',
    'Do not output the audit, reasoning, checklist, or correction process.'
  ];

  if (partName === 'part5') {
    lines.push(
      '',
      'Return {"questions": [...]}.',
      'Create exactly 5 Part 5 questions.',
      'Difficulty distribution for these 5 questions:',
      'Create exactly 2 questions at approximately TOEIC 750-800 level.',
      'Create exactly 2 questions at approximately TOEIC 850-900 level.',
      'Create exactly 1 question at approximately TOEIC 900-950 level.',
      'Every stem must contain exactly one blank written as -------.',
      'Use each of these questionType values in this exact distribution:',
      '"part_of_speech": exactly 1',
      '"tense_or_agreement": exactly 1',
      '"conjunction_or_preposition": exactly 1',
      '"vocabulary_or_collocation": exactly 2',
      'The three grammar questions must test three different rules.',
      'For grammar items, keep options parallel in form when appropriate.',
      'For vocabulary items, use four plausible business words or collocations.',
      'Avoid elementary patterns that are obvious without understanding context.',
      'Do not use made-up words merely to create distractors.'
    );
  } else if (
    partName === 'part6'
  ) {
    lines.push(
      '',
      'Return an object with:',
      'documentType',
      'passage',
      'passageTranslation',
      'questions',
      '',
      'documentType must be "Business Email", "Internal Notice", or "Customer Notice".',
      'Write one coherent final passage of approximately 120-190 English words.',
      'The passage must contain [1], [2], [3], and [4] in ascending order.',
      'Each marker must appear exactly once in passage.',
      'Do not repeat any marker or use any other bracketed blank marker.',
      'Do not include an earlier draft, correction, verification, or repeated passage.',
      'Questions must identify their blank only with blankNumber.',
      'Do not repeat marker text such as [1] in question fields.',
      'passageTranslation must be natural Korean and preserve each marker once.',
      'Do not fill the answers into passageTranslation.',
      'Create exactly 4 questions.',
      'Difficulty distribution for these 4 questions:',
      'Create exactly 1 question at approximately TOEIC 750-800 level.',
      'Create exactly 2 questions at approximately TOEIC 850-900 level.',
      'Create exactly 1 question at approximately TOEIC 900-950 level.',
      'Each question must also contain blankNumber: integer 1-4.',
      'Use every blankNumber exactly once.',
      'Use questionType "sentence_insertion" exactly once.',
      'Use questionType "grammar_or_vocabulary" exactly three times.',
      'For sentence_insertion, all four options must be complete sentences.',
      'Only the correct sentence may fit both surrounding sentences.',
      'The other sentences must fail cohesion, reference, tense, or purpose.',
      'For grammar_or_vocabulary, make all four choices plausible in context.'
    );
  } else {
    lines.push(
      '',
      'Return an object with:',
      'documentType',
      'passage',
      'passageTranslation',
      'questions',
      '',
      'documentType must be "Job Posting", "Event Notice", "Article", or "Customer Inquiry".',
      'Write one coherent passage of approximately 170-260 English words.',
      'Difficulty distribution for these 4 questions:',
      'Create exactly 1 question at approximately TOEIC 750-800 level.',
      'Create exactly 2 questions at approximately TOEIC 850-900 level.',
      'Create exactly 1 question at approximately TOEIC 900-950 level.',
      'Create exactly 4 questions using each questionType exactly once:',
      '"purpose_or_topic"',
      '"detail"',
      '"inference"',
      '"synonym"',
      'The detail answer must be explicitly supported by the passage.',
      'The inference must follow from context and must not merely restate one sentence.',
      'The synonym item must test a context-dependent business-English word.',
      'For the synonym question, also return targetWord.',
      'targetWord must appear exactly as written in passage.',
      'All answers must be supported only by the passage.',
      'For reading explanations, identify the supporting sentence or contextual clue.'
    );
  }

  if (feedback) {
    lines.push(feedback);
  }

  return lines.join('\n');
}

function validateQuiz_(quiz) {
  validatePart_(
    'part5',
    quiz.part5
  );

  validatePart_(
    'part6',
    quiz.part6
  );

  validatePart_(
    'part7',
    quiz.part7
  );
}

function validatePart_(
  partName,
  part
) {
  if (
    !part ||
    !Array.isArray(
      part.questions
    )
  ) {
    throw new Error(
      partName +
      ' questions 없음'
    );
  }

  const expectedCount =
    partName === 'part5'
      ? 5
      : 4;

  if (
    part.questions.length !==
    expectedCount
  ) {
    throw new Error(
      partName +
      ' 문항 수 오류'
    );
  }

  if (
    partName !== 'part5' &&
    (
      !part.passage ||
      !part.passageTranslation
    )
  ) {
    throw new Error(
      partName +
      ' 지문 또는 해석 누락'
    );
  }

  if (
    partName !== 'part5' &&
    !containsKorean_(
      part.passageTranslation
    )
  ) {
    throw new Error(
      partName +
      ' 지문 한국어 해석 오류'
    );
  }

  const allowedDocumentTypes = {
    part6: [
      'Business Email',
      'Internal Notice',
      'Customer Notice'
    ],
    part7: [
      'Job Posting',
      'Event Notice',
      'Article',
      'Customer Inquiry'
    ]
  };

  if (
    partName !== 'part5' &&
    allowedDocumentTypes[
      partName
    ].indexOf(
      part.documentType
    ) < 0
  ) {
    throw new Error(
      partName +
      ' documentType 오류: ' +
      String(part.documentType)
    );
  }

  if (partName === 'part6') {
    const markers = [
      '[1]',
      '[2]',
      '[3]',
      '[4]'
    ];

    markers.forEach(
      function (marker) {
        const passageCount =
          countLiteral_(
            part.passage,
            marker
          );

        if (passageCount !== 1) {
          throw new Error(
            'Part 6 ' +
            marker +
            ' 개수 오류: ' +
            passageCount
          );
        }

        const translationCount =
          countLiteral_(
            part.passageTranslation,
            marker
          );

        if (translationCount !== 1) {
          throw new Error(
            'Part 6 번역 ' +
            marker +
            ' 개수 오류: ' +
            translationCount
          );
        }
      }
    );

    const markerPositions =
      markers.map(
        function (marker) {
          return part.passage.indexOf(
            marker
          );
        }
      );

    for (
      let index = 1;
      index < markerPositions.length;
      index++
    ) {
      if (
        markerPositions[index] <=
        markerPositions[index - 1]
      ) {
        throw new Error(
          'Part 6 빈칸 순서 오류'
        );
      }
    }

    const allNumberedMarkers =
      String(part.passage).match(
        /\[\d+\]/g
      ) || [];

    if (
      allNumberedMarkers.length !== 4
    ) {
      throw new Error(
        'Part 6 숫자 빈칸 총개수 오류: ' +
        allNumberedMarkers.length
      );
    }

    const forbiddenPatterns = [
      /wait,?\s+let me/i,
      /let me correct/i,
      /let'?s re-verify/i,
      /thought process/i,
      /keep the text flowing/i,
      /here is the corrected/i,
      /here is the final passage/i
    ];

    forbiddenPatterns.forEach(
      function (pattern) {
        if (
          pattern.test(
            part.passage
          )
        ) {
          throw new Error(
            'Part 6 생성 과정 문구 노출'
          );
        }
      }
    );

    const part6WordCount =
      countEnglishWords_(
        part.passage
      );

    if (
      part6WordCount < 100 ||
      part6WordCount > 220
    ) {
      throw new Error(
        'Part 6 지문 길이 오류: ' +
        part6WordCount +
        ' words'
      );
    }
  }

  if (partName === 'part7') {
    const part7WordCount =
      countEnglishWords_(
        part.passage
      );

    if (
      part7WordCount < 140 ||
      part7WordCount > 320
    ) {
      throw new Error(
        'Part 7 지문 길이 오류: ' +
        part7WordCount +
        ' words'
      );
    }
  }

  const allowedTypesByPart = {
    part5: [
      'part_of_speech',
      'tense_or_agreement',
      'conjunction_or_preposition',
      'vocabulary_or_collocation'
    ],
    part6: [
      'sentence_insertion',
      'grammar_or_vocabulary'
    ],
    part7: [
      'purpose_or_topic',
      'detail',
      'inference',
      'synonym'
    ]
  };

  const expectedTypesByPart = {
    part5: {
      part_of_speech: 1,
      tense_or_agreement: 1,
      conjunction_or_preposition: 1,
      vocabulary_or_collocation: 2
    },
    part6: {
      sentence_insertion: 1,
      grammar_or_vocabulary: 3
    },
    part7: {
      purpose_or_topic: 1,
      detail: 1,
      inference: 1,
      synonym: 1
    }
  };

  const typeCounts = {};
  const questionKeys = {};
  const part6BlankNumbers = [];

  part.questions.forEach(
    function (
      question,
      index
    ) {
      if (
        !question.question ||
        !Array.isArray(
          question.options
        ) ||
        question.options.length !== 4
      ) {
        throw new Error(
          partName +
          ' ' +
          (index + 1) +
          '번 형식 오류'
        );
      }

      if (
        allowedTypesByPart[
          partName
        ].indexOf(
          question.questionType
        ) < 0
      ) {
        throw new Error(
          partName +
          ' ' +
          (index + 1) +
          '번 questionType 오류: ' +
          String(
            question.questionType
          )
        );
      }

      typeCounts[
        question.questionType
      ] =
        (
          typeCounts[
            question.questionType
          ] || 0
        ) + 1;

      const optionKeys = {};

      question.options.forEach(
        function (option) {
          const optionText =
            String(option).trim();

          if (
            !optionText ||
            optionText.length > 65
          ) {
            throw new Error(
              partName +
              ' 선택지 길이 오류'
            );
          }

          const optionKey =
            normalizeText_(
              optionText
            );

          if (optionKeys[optionKey]) {
            throw new Error(
              partName +
              ' 중복 선택지 발견'
            );
          }

          optionKeys[optionKey] = true;
        }
      );

      if (
        !Number.isInteger(
          question.answerIndex
        ) ||
        question.answerIndex < 0 ||
        question.answerIndex > 3
      ) {
        throw new Error(
          partName +
          ' 정답 인덱스 오류'
        );
      }

      if (
        !question.questionTranslation ||
        !question.explanation ||
        !containsKorean_(
          question.questionTranslation
        ) ||
        !containsKorean_(
          question.explanation
        )
      ) {
        throw new Error(
          partName +
          ' 해설 누락'
        );
      }

      if (
        !Array.isArray(
          question.optionExplanations
        ) ||
        question
          .optionExplanations
          .length !== 4
      ) {
        throw new Error(
          partName +
          ' 선택지 해설 오류'
        );
      }

      question
        .optionExplanations
        .forEach(
          function (
            optionExplanation
          ) {
            if (
              !optionExplanation ||
              !containsKorean_(
                optionExplanation
              )
            ) {
              throw new Error(
                partName +
                ' 선택지별 한국어 해설 오류'
              );
            }
          }
        );

      if (
        !Array.isArray(
          question.vocabulary
        ) ||
        question.vocabulary.length < 2 ||
        question.vocabulary.length > 5 ||
        question.vocabulary.some(
          function (item) {
            return !String(
              item || ''
            ).trim();
          }
        )
      ) {
        throw new Error(
          partName +
          ' 어휘 목록 오류'
        );
      }

      const questionKey =
        normalizeText_(
          (
            partName === 'part6'
              ? String(
                  question.blankNumber
                ) + ' '
              : ''
          ) +
          question.question
        );

      if (questionKeys[questionKey]) {
        throw new Error(
          partName +
          ' 중복 문제 발견'
        );
      }

      questionKeys[questionKey] = true;

      if (partName === 'part5') {
        const blankCount =
          countLiteral_(
            question.question,
            '-------'
          );

        if (blankCount !== 1) {
          throw new Error(
            'Part 5 ' +
            (index + 1) +
            '번 빈칸 개수 오류'
          );
        }
      }

      if (partName === 'part6') {
        if (
          !Number.isInteger(
            question.blankNumber
          ) ||
          question.blankNumber < 1 ||
          question.blankNumber > 4
        ) {
          throw new Error(
            'Part 6 blankNumber 오류'
          );
        }

        if (
          /\[\d+\]/.test(
            question.question
          )
        ) {
          throw new Error(
            'Part 6 질문에 빈칸 마커 노출'
          );
        }

        part6BlankNumbers.push(
          question.blankNumber
        );

        if (
          question.questionType ===
          'sentence_insertion'
        ) {
          question.options.forEach(
            function (option) {
              const optionText =
                String(option).trim();

              if (
                optionText.length < 12 ||
                !/[.!?]["']?$/.test(
                  optionText
                )
              ) {
                throw new Error(
                  'Part 6 문장 삽입 선택지 형식 오류'
                );
              }
            }
          );
        }
      }

      if (
        partName === 'part7' &&
        question.questionType ===
        'synonym'
      ) {
        const targetWord =
          String(
            question.targetWord || ''
          ).trim();

        if (
          !targetWord ||
          part.passage.indexOf(
            targetWord
          ) < 0
        ) {
          throw new Error(
            'Part 7 synonym targetWord 오류'
          );
        }
      }
    }
  );

  assertTypeCounts_(
    partName,
    typeCounts,
    expectedTypesByPart[
      partName
    ]
  );

  if (partName === 'part6') {
    const sortedBlankNumbers =
      part6BlankNumbers
        .slice()
        .sort(
          function (a, b) {
            return a - b;
          }
        );

    if (
      sortedBlankNumbers.join(',') !==
      '1,2,3,4'
    ) {
      throw new Error(
        'Part 6 blankNumber 중복 또는 누락'
      );
    }
  }
}

function assertTypeCounts_(
  partName,
  actualCounts,
  expectedCounts
) {
  Object
    .keys(expectedCounts)
    .forEach(function (type) {
      const actual =
        actualCounts[type] || 0;

      if (
        actual !==
        expectedCounts[type]
      ) {
        throw new Error(
          partName +
          ' questionType 구성 오류: ' +
          type +
          '=' +
          actual
        );
      }
    });
}

function countLiteral_(
  text,
  literal
) {
  return String(text || '')
    .split(literal)
    .length - 1;
}

function countEnglishWords_(text) {
  const matches =
    String(text || '').match(
      /[A-Za-z]+(?:['-][A-Za-z]+)*/g
    );

  return matches
    ? matches.length
    : 0;
}

function containsKorean_(text) {
  return /[가-힣]/.test(
    String(text || '')
  );
}

function normalizeText_(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function setQuestionIds_(
  questions,
  prefix
) {
  questions.forEach(
    function (
      question,
      index
    ) {
      question.id =
        prefix +
        'Q' +
        (index + 1);
    }
  );
}

function storeQuiz_(quiz) {
  const properties =
    PropertiesService
      .getScriptProperties();

  const allProperties =
    properties.getProperties();

  Object
    .keys(allProperties)
    .forEach(function (key) {
      if (
        key.indexOf(
          CONFIG.QUIZ_PREFIX
        ) === 0 ||
        key.indexOf(
          CONFIG.SUBMISSION_PREFIX
        ) === 0 ||
        key === CONFIG.META_KEY
      ) {
        properties
          .deleteProperty(key);
      }
    });

  const entries = {};

  const meta = {
    testId: quiz.testId,
    date: quiz.date,
    part5Ids:
      quiz.part5.questions.map(
        function (question) {
          return question.id;
        }
      ),
    part6Ids:
      quiz.part6.questions.map(
        function (question) {
          return question.id;
        }
      ),
    part7Ids:
      quiz.part7.questions.map(
        function (question) {
          return question.id;
        }
      )
  };

  entries[
    CONFIG.META_KEY
  ] = JSON.stringify(meta);

  storePart_(
    entries,
    quiz,
    quiz.part5,
    'Part 5',
    ''
  );

  storePart_(
    entries,
    quiz,
    quiz.part6,
    'Part 6',
    quiz.part6.passageTranslation
  );

  storePart_(
    entries,
    quiz,
    quiz.part7,
    'Part 7',
    quiz.part7.passageTranslation
  );

  entries[
    CONFIG.QUIZ_PREFIX +
    quiz.testId +
    '_P6DOC'
  ] = JSON.stringify({
    documentType:
      quiz.part6.documentType,
    passage:
      quiz.part6.passage,
    passageTranslation:
      quiz.part6.passageTranslation
  });

  entries[
    CONFIG.QUIZ_PREFIX +
    quiz.testId +
    '_P7DOC'
  ] = JSON.stringify({
    documentType:
      quiz.part7.documentType,
    passage:
      quiz.part7.passage,
    passageTranslation:
      quiz.part7.passageTranslation
  });

  Object
    .keys(entries)
    .forEach(function (key) {
      assertPropertySize_(
        key,
        entries[key]
      );
    });

  properties.setProperties(
    entries,
    false
  );
}

function storePart_(
  entries,
  quiz,
  part,
  partLabel,
  passageTranslation
) {
  part.questions.forEach(
    function (
      question,
      index
    ) {
      const key =
        CONFIG.QUIZ_PREFIX +
        quiz.testId +
        '_' +
        question.id;

      entries[key] =
        JSON.stringify({
          id: question.id,
          part: partLabel,
          number: index + 1,
          question:
            question.question,
          options:
            question.options,
          answerIndex:
            question.answerIndex,
          questionTranslation:
            question
              .questionTranslation,
          explanation:
            question.explanation,
          optionExplanations:
            question
              .optionExplanations,
          vocabulary:
            question.vocabulary,
          passageTranslation:
            passageTranslation || ''
        });
    }
  );
}

function assertPropertySize_(
  key,
  value
) {
  const bytes =
    Utilities
      .newBlob(value)
      .getBytes()
      .length;

  if (
    bytes >
    CONFIG.MAX_PROPERTY_BYTES
  ) {
    throw new Error(
      key +
      ' 데이터가 너무 큽니다: ' +
      bytes
    );
  }
}

function loadQuiz_() {
  const properties =
    PropertiesService
      .getScriptProperties();

  const metaText =
    properties.getProperty(
      CONFIG.META_KEY
    );

  if (!metaText) {
    throw new Error(
      '저장된 오늘의 문제가 없습니다.'
    );
  }

  const meta =
    JSON.parse(metaText);

  function loadQuestions(ids) {
    return ids.map(
      function (id) {
        const text =
          properties.getProperty(
            CONFIG.QUIZ_PREFIX +
            meta.testId +
            '_' +
            id
          );

        if (!text) {
          throw new Error(
            id +
            ' 문제 데이터가 없습니다.'
          );
        }

        return JSON.parse(text);
      }
    );
  }

  const part6Document =
    JSON.parse(
      properties.getProperty(
        CONFIG.QUIZ_PREFIX +
        meta.testId +
        '_P6DOC'
      )
    );

  const part7Document =
    JSON.parse(
      properties.getProperty(
        CONFIG.QUIZ_PREFIX +
        meta.testId +
        '_P7DOC'
      )
    );

  return {
    testId: meta.testId,
    date: meta.date,

    part5: {
      questions:
        loadQuestions(
          meta.part5Ids
        )
    },

    part6: {
      documentType:
        part6Document.documentType,
      passage:
        part6Document.passage,
      passageTranslation:
        part6Document
          .passageTranslation,
      questions:
        loadQuestions(
          meta.part6Ids
        )
    },

    part7: {
      documentType:
        part7Document.documentType,
      passage:
        part7Document.passage,
      passageTranslation:
        part7Document
          .passageTranslation,
      questions:
        loadQuestions(
          meta.part7Ids
        )
    }
  };
}

function postLauncher_(
  webhookUrl,
  quiz
) {
  postSlack_(
    webhookUrl,
    {
      text:
        'TOEIC RC Daily Test — ' +
        quiz.date,

      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text:
              '📚 TOEIC RC Daily Test',
            emoji: true
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                '*' +
                quiz.date +
                '* · 총 13문항 · 예상 10분'
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*테스트 구성*\n' +
              '• Part 5 — 문법·어휘 5문항\n' +
              '• Part 6 — 빈칸 완성 4문항\n' +
              '• Part 7 — 독해 4문항'
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*오늘의 지문*\n' +
              '• *Part 6* — ' +
              escapeSlack_(
                quiz.part6
                  .documentType ||
                'Business Document'
              ) +
              '\n' +
              '• *Part 7* — ' +
              escapeSlack_(
                quiz.part7
                  .documentType ||
                'Business Document'
              )
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
              '제출 시 *점수, 오답 해설, ' +
              '선택지별 분석* 확인 가능.\n' +
              '_제출 전에는 정답이 ' +
              '공개되지 않습니다._'
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                '🤖 AI 생성 모델: `' +
                CONFIG.MODEL +
                '` · 난이도: `' +
                CONFIG.TARGET_DIFFICULTY +
                '`'
            }
          ]
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              action_id:
                'open_toeic_quiz',
              text: {
                type:
                  'plain_text',
                text:
                  'Daily RC 풀기',
                emoji: true
              },
              value: quiz.testId
            }
          ]
        }
      ]
    }
  );
}

function openQuizModal_(
  triggerId
) {
  const quiz = loadQuiz_();

  callSlackApi_(
    'views.open',
    {
      trigger_id: triggerId,
      view:
        buildQuizView_(quiz)
    }
  );
}

function buildQuizView_(quiz) {
  const blocks = [];

  blocks.push(
    section_(
      '*' +
      quiz.date +
      '*\n' +
      '13문제를 모두 선택한 뒤 ' +
      '답안을 제출하세요.'
    )
  );

  addQuizPart_(
    blocks,
    '*Part 5 · Incomplete Sentences*',
    '',
    quiz.part5.questions
  );

  addQuizPart_(
    blocks,
    '*Part 6 · Text Completion*',
    '*' +
      escapeSlack_(
        quiz.part6.documentType ||
        'Business Document'
      ) +
      '*\n' +
      escapeSlack_(
        quiz.part6.passage
      ),
    quiz.part6.questions
  );

  addQuizPart_(
    blocks,
    '*Part 7 · Reading Comprehension*',
    '*' +
      escapeSlack_(
        quiz.part7.documentType ||
        'Business Document'
      ) +
      '*\n' +
      escapeSlack_(
        quiz.part7.passage
      ),
    quiz.part7.questions
  );

  return {
    type: 'modal',
    callback_id:
      'toeic_quiz_submit',
    private_metadata:
      quiz.testId,

    title: {
      type: 'plain_text',
      text: 'TOEIC RC Test'
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

function addQuizPart_(
  blocks,
  heading,
  passage,
  questions
) {
  blocks.push({
    type: 'divider'
  });

  blocks.push(
    section_(heading)
  );

  if (passage) {
    addSectionChunks_(
      blocks,
      passage
    );
  }

  questions.forEach(
    function (question) {
      blocks.push({
        type: 'input',
        block_id: question.id,

        label: {
          type: 'plain_text',
          text:
            question.part +
            ' ' +
            question.number +
            '. ' +
            question.question
        },

        element: {
          type: 'radio_buttons',
          action_id: 'answer',

          options:
            question.options.map(
              function (
                option,
                index
              ) {
                const label =
                  ['A', 'B', 'C', 'D'][
                    index
                  ];

                return {
                  text: {
                    type:
                      'plain_text',
                    text:
                      '(' +
                      label +
                      ') ' +
                      option
                  },

                  value:
                    String(index)
                };
              }
            )
        }
      });
    }
  );
}

function handleQuizSubmission_(
  payload
) {
  const quiz = loadQuiz_();

  if (
    payload.view.private_metadata !==
    quiz.testId
  ) {
    return jsonOutput_({
      response_action: 'errors',

      errors: {
        P5Q1:
          '새 문제가 등록되었습니다. ' +
          '창을 닫고 다시 시작해주세요.'
      }
    });
  }

  const state =
    payload.view.state.values;

  const answers = {};

  allQuestions_(quiz)
    .forEach(function (question) {
      answers[question.id] =
        Number(
          state[
            question.id
          ].answer
            .selected_option
            .value
        );
    });

  const submission =
    grade_(
      quiz,
      answers
    );

  submission.userId =
    payload.user.id;

  storeSubmission_(
    quiz.testId,
    submission
  );

  return jsonOutput_({
    response_action: 'update',
    view:
      buildScoreView_(
        quiz,
        submission
      )
  });
}

function grade_(
  quiz,
  answers
) {
  const result = {
    answers: answers,
    correct: 0,
    total: 13,

    parts: {
      'Part 5': {
        correct: 0,
        total: 5
      },

      'Part 6': {
        correct: 0,
        total: 4
      },

      'Part 7': {
        correct: 0,
        total: 4
      }
    }
  };

  allQuestions_(quiz)
    .forEach(function (question) {
      if (
        answers[question.id] ===
        question.answerIndex
      ) {
        result.correct++;

        result
          .parts[
            question.part
          ]
          .correct++;
      }
    });

  return result;
}

function storeSubmission_(
  testId,
  submission
) {
  const key =
    CONFIG.SUBMISSION_PREFIX +
    testId +
    '_' +
    submission.userId;

  PropertiesService
    .getScriptProperties()
    .setProperty(
      key,
      JSON.stringify(
        submission
      )
    );
}

function loadSubmission_(
  testId,
  userId
) {
  const key =
    CONFIG.SUBMISSION_PREFIX +
    testId +
    '_' +
    userId;

  const text =
    PropertiesService
      .getScriptProperties()
      .getProperty(key);

  if (!text) {
    throw new Error(
      '제출 기록이 없습니다.'
    );
  }

  return JSON.parse(text);
}

function buildScoreView_(
  quiz,
  submission
) {
  const percentage =
    Math.round(
      submission.correct /
      submission.total *
      1000
    ) / 10;

  return {
    type: 'modal',
    callback_id: 'toeic_score',
    private_metadata:
      quiz.testId,

    title: {
      type: 'plain_text',
      text: '채점 결과'
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
          text: '🎉 채점 완료',
          emoji: true
        }
      },

      section_(
        '*총점: ' +
        submission.correct +
        ' / ' +
        submission.total +
        '*  ·  정답률 ' +
        percentage +
        '%\n\n' +

        'Part 5: ' +
        submission.parts[
          'Part 5'
        ].correct +
        ' / 5\n' +

        'Part 6: ' +
        submission.parts[
          'Part 6'
        ].correct +
        ' / 4\n' +

        'Part 7: ' +
        submission.parts[
          'Part 7'
        ].correct +
        ' / 4'
      ),

      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            action_id:
              'show_all_explanations',

            text: {
              type:
                'plain_text',
              text:
                '전체 해설 보기'
            },

            value:
              quiz.testId
          },

          {
            type: 'button',
            action_id:
              'show_wrong_explanations',

            text: {
              type:
                'plain_text',
              text:
                '틀린 문제만 보기'
            },

            value:
              quiz.testId
          }
        ]
      }
    ]
  };
}

function updateResultsModal_(
  payload,
  wrongOnly
) {
  const quiz = loadQuiz_();

  const submission =
    loadSubmission_(
      quiz.testId,
      payload.user.id
    );

  callSlackApi_(
    'views.update',
    {
      view_id:
        payload.view.id,

      hash:
        payload.view.hash,

      view:
        buildExplanationView_(
          quiz,
          submission,
          wrongOnly
        )
    }
  );
}

function updateScoreModal_(
  payload
) {
  const quiz = loadQuiz_();

  const submission =
    loadSubmission_(
      quiz.testId,
      payload.user.id
    );

  callSlackApi_(
    'views.update',
    {
      view_id:
        payload.view.id,

      hash:
        payload.view.hash,

      view:
        buildScoreView_(
          quiz,
          submission
        )
    }
  );
}

function buildExplanationView_(
  quiz,
  submission,
  wrongOnly
) {
  const blocks = [
    {
      type: 'actions',

      elements: [
        {
          type: 'button',
          action_id:
            'back_to_score',

          text: {
            type:
              'plain_text',
            text:
              '← 점수로 돌아가기'
          },

          value:
            quiz.testId
        }
      ]
    }
  ];

  const questions =
    allQuestions_(quiz)
      .filter(function (question) {
        return (
          !wrongOnly ||
          submission.answers[
            question.id
          ] !==
          question.answerIndex
        );
      });

  if (!questions.length) {
    blocks.push(
      section_(
        '*모든 문제를 맞혔습니다! 🎉*'
      )
    );
  }

  let previousPart = '';

  questions.forEach(
    function (question) {
      if (
        question.part !==
        previousPart
      ) {
        blocks.push({
          type: 'divider'
        });

        blocks.push(
          section_(
            '*' +
            question.part +
            '*'
          )
        );

        if (
          question.part ===
          'Part 6'
        ) {
          addSectionChunks_(
            blocks,
            '*지문 해석*\n' +
            escapeSlack_(
              quiz
                .part6
                .passageTranslation
            )
          );
        }

        if (
          question.part ===
          'Part 7'
        ) {
          addSectionChunks_(
            blocks,
            '*지문 해석*\n' +
            escapeSlack_(
              quiz
                .part7
                .passageTranslation
            )
          );
        }

        previousPart =
          question.part;
      }

      addSectionChunks_(
        blocks,
        explanationText_(
          question,
          submission.answers[
            question.id
          ]
        )
      );
    }
  );

  if (blocks.length > 100) {
    throw new Error(
      '해설 Modal 블록 수가 ' +
      '100개를 초과했습니다.'
    );
  }

  return {
    type: 'modal',
    callback_id:
      'toeic_explanations',
    private_metadata:
      quiz.testId,

    title: {
      type: 'plain_text',
      text:
        wrongOnly
          ? '오답 해설'
          : '전체 해설'
    },

    close: {
      type: 'plain_text',
      text: '닫기'
    },

    blocks: blocks
  };
}

function explanationText_(
  question,
  selectedIndex
) {
  const labels = [
    'A',
    'B',
    'C',
    'D'
  ];

  const isCorrect =
    selectedIndex ===
    question.answerIndex;

  const lines = [
    '*' +
      question.number +
      '번 · ' +
      (
        isCorrect
          ? '✅ 정답'
          : '❌ 오답'
      ) +
      '*',

    escapeSlack_(
      question.question
    ),

    '내 선택: *(' +
      labels[selectedIndex] +
      ')* ' +
      escapeSlack_(
        question.options[
          selectedIndex
        ]
      ),

    '정답: *(' +
      labels[
        question.answerIndex
      ] +
      ')* ' +
      escapeSlack_(
        question.options[
          question.answerIndex
        ]
      ),

    '',
    '*해석*',

    escapeSlack_(
      question
        .questionTranslation
    ),

    '',
    '*핵심 해설*',

    escapeSlack_(
      question.explanation
    ),

    '',
    '*선택지 해설*'
  ];

  question
    .optionExplanations
    .forEach(
      function (
        explanation,
        index
      ) {
        lines.push(
          '(' +
          labels[index] +
          ') ' +
          escapeSlack_(
            explanation
          )
        );
      }
    );

  if (
    question.vocabulary &&
    question.vocabulary.length
  ) {
    lines.push(
      '',
      '*핵심 어휘*'
    );

    question.vocabulary.forEach(
      function (item) {
        lines.push(
          '• ' +
          escapeSlack_(
            String(item)
          )
        );
      }
    );
  }

  return lines.join('\n');
}

function allQuestions_(quiz) {
  return quiz
    .part5
    .questions
    .concat(
      quiz.part6.questions,
      quiz.part7.questions
    );
}

function callSlackApi_(
  method,
  body
) {
  const botToken =
    getSettings_().botToken;

  const response =
    UrlFetchApp.fetch(
      'https://slack.com/api/' +
      method,
      {
        method: 'post',
        contentType:
          'application/json; charset=utf-8',

        headers: {
          Authorization:
            'Bearer ' +
            botToken
        },

        payload:
          JSON.stringify(body),

        muteHttpExceptions:
          true
      }
    );

  let data;

  try {
    data =
      JSON.parse(
        response.getContentText()
      );
  } catch (error) {
    throw new Error(
      'Slack API 응답 파싱 실패'
    );
  }

  if (!data.ok) {
    throw new Error(
      'Slack ' +
      method +
      ' 실패: ' +
      (
        data.error ||
        'unknown'
      )
    );
  }

  return data;
}

function postSlack_(
  webhookUrl,
  payload
) {
  const response =
    UrlFetchApp.fetch(
      webhookUrl,
      {
        method: 'post',
        contentType:
          'application/json',

        payload:
          JSON.stringify(payload),

        muteHttpExceptions:
          true
      }
    );

  const responseCode =
    response.getResponseCode();

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      'Slack Webhook HTTP ' +
      responseCode
    );
  }
}

function section_(text) {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: text
    }
  };
}

function addSectionChunks_(
  blocks,
  text
) {
  splitText_(
    text,
    CONFIG.MAX_SECTION_LENGTH
  ).forEach(
    function (chunk) {
      blocks.push(
        section_(chunk)
      );
    }
  );
}

function splitText_(
  text,
  maxLength
) {
  const chunks = [];

  let remaining =
    String(text || '');

  while (
    remaining.length >
    maxLength
  ) {
    let cutPosition =
      remaining.lastIndexOf(
        '\n',
        maxLength
      );

    if (
      cutPosition <
      maxLength * 0.6
    ) {
      cutPosition =
        maxLength;
    }

    chunks.push(
      remaining.slice(
        0,
        cutPosition
      )
    );

    remaining =
      remaining
        .slice(cutPosition)
        .replace(
          /^\n+/,
          ''
        );
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function escapeSlack_(text) {
  return String(
    text == null
      ? ''
      : text
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    );
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(
      JSON.stringify(value)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}

function textOutput_(value) {
  return ContentService
    .createTextOutput(
      value || ''
    );
}

function getRecentThemes_() {
  try {
    return JSON.parse(
      PropertiesService
        .getScriptProperties()
        .getProperty(
          CONFIG.HISTORY_KEY
        ) || '[]'
    );
  } catch (error) {
    return [];
  }
}

function rememberThemes_(quiz) {
  const properties =
    PropertiesService
      .getScriptProperties();

  const history =
    getRecentThemes_();

  history.unshift(
    [
      quiz.part6.documentType ||
        '',

      String(
        quiz.part6.passage ||
        ''
      ).slice(0, 100),

      quiz.part7.documentType ||
        '',

      String(
        quiz.part7.passage ||
        ''
      ).slice(0, 100)
    ].join(' ')
  );

  properties.setProperty(
    CONFIG.HISTORY_KEY,
    JSON.stringify(
      history.slice(0, 14)
    )
  );
}

function notifyFailureSafely_(
  message
) {
  try {
    const webhookUrl =
      PropertiesService
        .getScriptProperties()
        .getProperty(
          'SLACK_WEBHOOK_URL'
        );

    if (webhookUrl) {
      postSlack_(
        webhookUrl,
        {
          text:
            '*:warning: TOEIC Bot 실패*\n' +
            '```' +
            message.slice(
              0,
              2000
            ) +
            '```'
        }
      );
    }
  } catch (error) {
    Logger.log(
      '오류 알림도 실패: ' +
      error
    );
  }
}
