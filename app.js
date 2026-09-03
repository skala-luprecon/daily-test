/**
 * Daily Test CBT Arena - Application Logic (Vanilla JS)
 * Primary: Gemini 3.8 Flash (3 Retries, 1m backoff) / Fallback: Gemini 3.6 Flash
 * B-Layout (Split-Screen) + A-Palette (Warm Paper) + Obsidian Dark Mode
 */

const STATE = {
  subject: 'toeic', // 'toeic' | 'skct'
  date: '',
  availableDates: [],
  quizData: null,
  userAnswers: {}, // { Q_ID: optionIndex }
  isSubmitted: false,
  startTime: null,
  timerSeconds: 15 * 60,
  timerInterval: null,
  isTimerRunning: true,
  filterMode: 'all', // 'all' | 'wrong'
  activeQuestionId: null
};

// Cached DOM Elements
let DOM = {};

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initDomReferences();
  initTheme();
  setupEventListeners();
  await loadManifest();
  if (STATE.date) {
    await loadQuiz(STATE.subject, STATE.date);
  } else {
    renderEmptyState('아직 등록된 문제가 없습니다.', '매일 아침 7시(토익) / 8시(SKCT)에 새로운 문제가 자동으로 출제 및 아카이빙됩니다.');
  }
});

function initDomReferences() {
  DOM = {
    tabToeic: document.getElementById('tab-toeic'),
    tabSkct: document.getElementById('tab-skct'),
    dateSelect: document.getElementById('date-select'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    testTitle: document.getElementById('test-title'),
    testDateBadge: document.getElementById('test-date-badge'),
    testCountBadge: document.getElementById('test-count-badge'),
    testModelBadge: document.getElementById('test-model-badge'),
    timerDisplay: document.getElementById('timer-display'),
    btnTimerToggle: document.getElementById('btn-timer-toggle'),
    btnTimerReset: document.getElementById('btn-timer-reset'),
    progressText: document.getElementById('progress-text'),
    progressFill: document.getElementById('progress-fill'),
    scoreHero: document.getElementById('score-hero'),
    scoreGradeBadge: document.getElementById('score-grade-badge'),
    statScore: document.getElementById('stat-score'),
    statAccuracy: document.getElementById('stat-accuracy'),
    statTime: document.getElementById('stat-time'),
    btnFilterAll: document.getElementById('btn-filter-all'),
    btnFilterWrong: document.getElementById('btn-filter-wrong'),
    btnRetake: document.getElementById('btn-retake'),
    questionsList: document.getElementById('questions-list'),
    btnSubmitBottom: document.getElementById('btn-submit-bottom'),
    omrCountStatus: document.getElementById('omr-count-status'),
    omrGrid: document.getElementById('omr-grid'),
    btnSubmitSidebar: document.getElementById('btn-submit-sidebar')
  };
}

function setupEventListeners() {
  // Theme Toggle
  if (DOM.btnThemeToggle) {
    DOM.btnThemeToggle.addEventListener('click', toggleTheme);
  }

  // Subject Tabs
  DOM.tabToeic.addEventListener('click', () => switchSubject('toeic'));
  DOM.tabSkct.addEventListener('click', () => switchSubject('skct'));

  // Date Selector
  DOM.dateSelect.addEventListener('change', (e) => {
    STATE.date = e.target.value;
    loadQuiz(STATE.subject, STATE.date);
  });

  // Submit Buttons
  DOM.btnSubmitBottom.addEventListener('click', handleSubmit);
  DOM.btnSubmitSidebar.addEventListener('click', handleSubmit);

  // Timer Controls
  DOM.btnTimerToggle.addEventListener('click', toggleTimer);
  DOM.btnTimerReset.addEventListener('click', resetTimer);

  // Post-Submit Filters
  DOM.btnFilterAll.addEventListener('click', () => setFilterMode('all'));
  DOM.btnFilterWrong.addEventListener('click', () => setFilterMode('wrong'));
  DOM.btnRetake.addEventListener('click', handleRetake);

  // Event Delegation for Option Selection
  DOM.questionsList.addEventListener('click', (e) => {
    if (STATE.isSubmitted) return;
    const optionItem = e.target.closest('.option-item');
    if (!optionItem) return;
    const qid = optionItem.getAttribute('data-qid');
    const optIdx = parseInt(optionItem.getAttribute('data-opt'), 10);
    if (qid && !isNaN(optIdx)) {
      selectOption(qid, optIdx);
    }
  });

  // Focus tracking on click/hover for hotkeys
  DOM.questionsList.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.question-card');
    if (card) {
      const qid = card.id.replace('card-', '');
      if (qid) STATE.activeQuestionId = qid;
    }
  });

  // Event Delegation for OMR Navigation
  DOM.omrGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.omr-btn');
    if (!btn) return;
    const qid = btn.getAttribute('data-qid');
    if (!qid) return;
    STATE.activeQuestionId = qid;
    const card = document.getElementById('card-' + qid);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // Keyboard Hotkeys: 1-4 or A-D to answer active question
  document.addEventListener('keydown', (e) => {
    if (STATE.isSubmitted) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

    const key = e.key.toUpperCase();
    let optIdx = -1;
    if (key === '1' || key === 'A') optIdx = 0;
    else if (key === '2' || key === 'B') optIdx = 1;
    else if (key === '3' || key === 'C') optIdx = 2;
    else if (key === '4' || key === 'D') optIdx = 3;

    if (optIdx !== -1 && STATE.activeQuestionId) {
      selectOption(STATE.activeQuestionId, optIdx);
    }
  });
}

// ============================================================================
// THEME MANAGEMENT (Light / Dark)
// ============================================================================
function initTheme() {
  const savedTheme = localStorage.getItem('daily_test_theme') || 'light';
  applyTheme(savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('daily_test_theme', theme);

  if (DOM.btnThemeToggle) {
    const icon = DOM.btnThemeToggle.querySelector('.theme-icon');
    const label = DOM.btnThemeToggle.querySelector('.theme-label');
    if (theme === 'dark') {
      if (icon) icon.textContent = '☀️';
      if (label) label.textContent = 'LIGHT';
    } else {
      if (icon) icon.textContent = '🌙';
      if (label) label.textContent = 'DARK';
    }
  }
}

// ============================================================================
// MANIFEST & DATA FETCHING
// ============================================================================
async function loadManifest() {
  try {
    const res = await fetch('./data/manifest.json');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.dates) && data.dates.length > 0) {
        STATE.availableDates = data.dates;
        STATE.date = data.latest || data.dates[data.dates.length - 1];
      }
    }
  } catch (err) {
    console.warn('Manifest load fallback:', err);
  }
  populateDateDropdown();
}

function populateDateDropdown() {
  DOM.dateSelect.innerHTML = '';
  if (STATE.availableDates.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '등록된 일자 없음';
    DOM.dateSelect.appendChild(opt);
    return;
  }

  STATE.availableDates.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    if (d === STATE.date) opt.selected = true;
    DOM.dateSelect.appendChild(opt);
  });
}

async function switchSubject(subject) {
  if (STATE.subject === subject) return;
  STATE.subject = subject;

  DOM.tabToeic.classList.toggle('active', subject === 'toeic');
  DOM.tabSkct.classList.toggle('active', subject === 'skct');

  if (STATE.date) {
    await loadQuiz(STATE.subject, STATE.date);
  } else {
    renderEmptyState('아직 등록된 문제가 없습니다.', '매일 아침 7시(토익) / 8시(SKCT)에 새로운 문제가 자동으로 출제 및 아카이빙됩니다.');
  }
}

async function loadQuiz(subject, date) {
  if (!date) {
    renderEmptyState('아직 등록된 문제가 없습니다.', '매일 아침 7시(토익) / 8시(SKCT)에 새로운 문제가 자동으로 출제 및 아카이빙됩니다.');
    return;
  }

  const filePath = './data/' + subject + '/' + date + '_' + subject.toUpperCase() + '.json';
  
  try {
    const res = await fetch(filePath);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    STATE.quizData = await res.json();
    resetQuizState();
    renderQuiz();
    startTimer();
  } catch (err) {
    console.error('Quiz load error:', err);
    renderEmptyState('출제된 문제를 준비 중입니다.', date + ' 일자의 데이터가 아직 아카이빙되지 않았습니다.');
  }
}

function renderEmptyState(title, subtitle) {
  DOM.questionsList.innerHTML = 
    '<div class="question-card" style="text-align: center; padding: 4rem 2rem;">' +
      '<span style="font-size: 2.5rem; display: block; margin-bottom: 0.8rem;">📅</span>' +
      '<h3 style="font-family: var(--font-ui); font-size: 1.15rem; font-weight: 700; color: var(--text-ink);">' + escapeHtml(title) + '</h3>' +
      '<p style="color: var(--text-muted); margin-top: 0.5rem; font-size: 0.88rem;">' + escapeHtml(subtitle) + '</p>' +
    '</div>';
  DOM.btnSubmitBottom.style.display = 'none';
  DOM.btnSubmitSidebar.style.display = 'none';
  DOM.omrGrid.innerHTML = '';
}

function resetQuizState() {
  STATE.userAnswers = {};
  STATE.isSubmitted = false;
  STATE.startTime = Date.now();
  STATE.filterMode = 'all';
  STATE.activeQuestionId = null;
  DOM.scoreHero.classList.add('hidden');
  DOM.btnSubmitBottom.style.display = 'flex';
  DOM.btnSubmitSidebar.style.display = 'flex';
  updateProgress();
}

// ============================================================================
// RENDERING (B-Style Split-Screen for Passages & Authentic Paper Typography)
// ============================================================================
function renderQuiz() {
  const quiz = STATE.quizData;
  if (!quiz) return;

  // Header badges
  DOM.testTitle.textContent = quiz.title || (quiz.type === 'TOEIC' ? 'TOEIC RC 실전 평가' : 'SKCT 인지역량 평가');
  DOM.testDateBadge.textContent = quiz.date;
  DOM.testCountBadge.textContent = '총 ' + quiz.questions.length + '문항';
  DOM.testModelBadge.textContent = quiz.model || 'gemini-3.8-flash';

  DOM.questionsList.innerHTML = '';

  if (quiz.questions.length > 0) {
    STATE.activeQuestionId = quiz.questions[0].id;
  }

  // 1. Group consecutive questions by part and scenario
  const sections = [];
  let currentSection = null;

  quiz.questions.forEach((q) => {
    const isSamePart = currentSection && currentSection.part === q.part;
    const isSameScenario = currentSection && (currentSection.scenario || '') === (q.scenario || '');

    if (isSamePart && isSameScenario) {
      currentSection.questions.push(q);
    } else {
      currentSection = {
        part: q.part,
        scenario: q.scenario || '',
        questions: [q]
      };
      sections.push(currentSection);
    }
  });

  // 2. Render each section with B-style split view or single view
  let lastRenderedPart = '';

  sections.forEach((sec, secIdx) => {
    // Part Header Banner
    if (sec.part && sec.part !== lastRenderedPart) {
      const partBanner = document.createElement('div');
      partBanner.className = 'part-header-banner';
      partBanner.innerHTML = '<span class="part-icon">📖</span> <span class="part-text">' + escapeHtml(sec.part) + '</span>';
      DOM.questionsList.appendChild(partBanner);
      lastRenderedPart = sec.part;
    }

    if (sec.scenario) {
      // B안 Split-Screen Pane (Left: Authentic Passage Document, Right: Questions)
      const splitPane = document.createElement('div');
      splitPane.className = 'cbt-split-pane';
      splitPane.id = 'split-section-' + secIdx;

      // Extract individual document cards if multiple ``` are present
      const rawScenario = String(sec.scenario).trim();
      const cardRegex = /```[\s\S]*?```/g;
      const matches = rawScenario.match(cardRegex) || [rawScenario];

      const innerDocsHtml = matches.map((cardStr, dIdx) => {
        const cleanDoc = cardStr.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
        const docStamp = matches.length > 1 ? '<div class="doc-header-stamp">DOCUMENT ' + (dIdx + 1) + '</div>' : '';
        return '<div class="scenario-doc-card">' + docStamp + '<pre>' + escapeHtml(cleanDoc) + '</pre></div>';
      }).join('');

      const leftPane = document.createElement('div');
      leftPane.className = 'passage-column';
      leftPane.innerHTML = 
        '<div class="passage-sticky-card">' +
          '<div class="passage-card-header">' +
            '<span class="passage-badge">📄 DOCUMENT / PASSAGE</span>' +
            '<span class="passage-hint">※ 지문을 읽고 우측 문제에 답하시오.</span>' +
          '</div>' +
          '<div class="passage-docs-wrapper">' +
            innerDocsHtml +
          '</div>' +
        '</div>';

      const rightPane = document.createElement('div');
      rightPane.className = 'questions-subgroup';

      sec.questions.forEach((q) => {
        rightPane.appendChild(createQuestionCardElement(q, 'split-section-' + secIdx));
      });

      splitPane.appendChild(leftPane);
      splitPane.appendChild(rightPane);
      DOM.questionsList.appendChild(splitPane);
    } else {
      // Single-Column Pane (No passage, e.g. Part 5 or direct math)
      const singlePane = document.createElement('div');
      singlePane.className = 'cbt-single-pane';
      singlePane.id = 'single-section-' + secIdx;

      sec.questions.forEach((q) => {
        singlePane.appendChild(createQuestionCardElement(q, null));
      });

      DOM.questionsList.appendChild(singlePane);
    }
  });

  renderOmrGrid();
  updateProgress();
}

function createQuestionCardElement(q, sectionId) {
  const card = document.createElement('div');
  card.className = 'question-card';
  card.id = 'card-' + q.id;
  if (sectionId) {
    card.setAttribute('data-section-id', sectionId);
  }

  const optionsHtml = q.options.map((opt, optIdx) => {
    const letter = ['A', 'B', 'C', 'D'][optIdx];
    const isSelected = STATE.userAnswers[q.id] === optIdx;
    return (
      '<div class="option-item ' + (isSelected ? 'selected' : '') + '" data-qid="' + q.id + '" data-opt="' + optIdx + '">' +
        '<span class="option-letter">' + letter + '</span>' +
        '<span class="option-text">' + escapeHtml(opt) + '</span>' +
      '</div>'
    );
  }).join('');

  card.innerHTML = 
    '<div class="question-title-row">' +
      '<span class="question-num-badge">' + q.number + '번</span>' +
      '<h3 class="question-text">' + escapeHtml(q.question) + '</h3>' +
    '</div>' +
    '<div class="options-list" id="opts-' + q.id + '">' +
      optionsHtml +
    '</div>' +
    '<div class="explanation-slot" id="expl-' + q.id + '"></div>';

  return card;
}

function selectOption(qid, optIdx) {
  STATE.userAnswers[qid] = optIdx;
  STATE.activeQuestionId = qid;

  // Update UI in question card
  const optsContainer = document.getElementById('opts-' + qid);
  if (optsContainer) {
    optsContainer.querySelectorAll('.option-item').forEach((item, idx) => {
      item.classList.toggle('selected', idx === optIdx);
    });
  }

  // Update OMR
  const omrBtn = document.getElementById('omr-' + qid);
  if (omrBtn) {
    omrBtn.classList.add('answered');
  }

  updateProgress();
}

function renderOmrGrid() {
  DOM.omrGrid.innerHTML = '';
  if (!STATE.quizData) return;

  STATE.quizData.questions.forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'omr-btn ' + (STATE.userAnswers[q.id] !== undefined ? 'answered' : '');
    btn.id = 'omr-' + q.id;
    btn.setAttribute('data-qid', q.id);
    btn.textContent = q.number;
    btn.title = q.number + '번 문제로 이동';
    DOM.omrGrid.appendChild(btn);
  });
}

function updateProgress() {
  if (!STATE.quizData) return;
  const total = STATE.quizData.questions.length;
  const answered = Object.keys(STATE.userAnswers).length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

  DOM.progressText.textContent = answered + ' / ' + total + ' (' + pct + '%)';
  DOM.progressFill.style.width = pct + '%';
  DOM.omrCountStatus.textContent = answered + ' / ' + total;
}

// ============================================================================
// SUBMISSION & SCORING
// ============================================================================
function handleSubmit() {
  if (STATE.isSubmitted || !STATE.quizData) return;

  const total = STATE.quizData.questions.length;
  const answered = Object.keys(STATE.userAnswers).length;

  if (answered < total) {
    const unansweredCount = total - answered;
    const confirm = window.confirm('아직 풀지 않은 문제가 ' + unansweredCount + '개 있습니다. 그래도 제출하시겠습니까?');
    if (!confirm) return;
  }

  STATE.isSubmitted = true;
  stopTimer();

  let correctCount = 0;
  STATE.quizData.questions.forEach((q) => {
    const userAns = STATE.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;
    if (isCorrect) correctCount++;

    const omrBtn = document.getElementById('omr-' + q.id);
    if (omrBtn) {
      omrBtn.classList.remove('answered');
      omrBtn.classList.add(isCorrect ? 'correct' : 'wrong');
    }

    renderQuestionExplanation(q, userAns, isCorrect);
  });

  const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  const elapsedSeconds = Math.round((Date.now() - STATE.startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');

  DOM.statScore.textContent = correctCount + ' / ' + total;
  DOM.statAccuracy.textContent = pct + '%';
  DOM.statTime.textContent = minutes + '분 ' + seconds + '초';

  let grade = '수고하셨습니다! 👍';
  if (pct === 100) grade = '만점! 상위 1% 킬러 정복 🏆';
  else if (pct >= 85) grade = '우수! 상위 10% 실력자 🔥';
  else if (pct >= 70) grade = '안정권! 합격 안정 점수 🎯';
  DOM.scoreGradeBadge.textContent = grade;

  DOM.scoreHero.classList.remove('hidden');
  DOM.btnSubmitBottom.style.display = 'none';
  DOM.btnSubmitSidebar.style.display = 'none';

  DOM.scoreHero.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderQuestionExplanation(q, userAns, isCorrect) {
  const slot = document.getElementById('expl-' + q.id);
  if (!slot) return;

  const labels = ['A', 'B', 'C', 'D'];
  const optExplsHtml = (q.optionExplanations || []).map((exp, idx) => {
    return '<div><strong>(' + labels[idx] + ')</strong> ' + escapeHtml(exp) + '</div>';
  }).join('');

  slot.innerHTML = 
    '<div class="explanation-card">' +
      '<div class="result-tag ' + (isCorrect ? 'result-correct' : 'result-wrong') + '">' +
        (isCorrect ? '✅ 정답입니다!' : '❌ 오답 (내 선택: (' + (labels[userAns] || '미선택') + ') / 정답: (' + labels[q.answerIndex] + '))') +
      '</div>' +
      '<div class="expl-box">' +
        '<strong>💡 [핵심 해설]</strong><br>' +
        escapeHtml(q.explanation || '해설이 제공되지 않습니다.') +
      '</div>' +
      (optExplsHtml ? 
        '<div class="expl-box expl-box-options">' +
          '<strong>🔍 [선택지별 분석]</strong>' +
          '<div class="option-expl-list">' +
            optExplsHtml +
          '</div>' +
        '</div>' : '') +
    '</div>';
}

function setFilterMode(mode) {
  STATE.filterMode = mode;
  DOM.btnFilterAll.classList.toggle('active', mode === 'all');
  DOM.btnFilterWrong.classList.toggle('active', mode === 'wrong');

  if (!STATE.quizData) return;

  const activeSectionIds = new Set();

  STATE.quizData.questions.forEach((q) => {
    const card = document.getElementById('card-' + q.id);
    if (!card) return;

    const userAns = STATE.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;
    const sectionId = card.getAttribute('data-section-id');

    if (mode === 'wrong' && isCorrect) {
      card.style.display = 'none';
    } else {
      card.style.display = 'block';
      if (sectionId) {
        activeSectionIds.add(sectionId);
      }
    }
  });

  // Control visibility of split panes
  document.querySelectorAll('.cbt-split-pane').forEach((pane) => {
    if (mode === 'wrong') {
      pane.style.display = activeSectionIds.has(pane.id) ? 'grid' : 'none';
    } else {
      pane.style.display = 'grid';
    }
  });
}

function handleRetake() {
  resetQuizState();
  renderQuiz();
  startTimer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================================
// TIMER
// ============================================================================
function startTimer() {
  clearInterval(STATE.timerInterval);
  const defaultMinutes = STATE.quizData && STATE.quizData.questions && STATE.quizData.questions.length > 12 ? 15 : 12;
  STATE.timerSeconds = defaultMinutes * 60;
  STATE.isTimerRunning = true;
  updateTimerDisplay();

  STATE.timerInterval = setInterval(() => {
    if (!STATE.isTimerRunning) return;
    STATE.timerSeconds--;
    updateTimerDisplay();
    if (STATE.timerSeconds <= 0) {
      clearInterval(STATE.timerInterval);
      alert('⏱️ 제한 시간이 종료되었습니다. 답안을 제출합니다.');
      handleSubmit();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = String(Math.floor(STATE.timerSeconds / 60)).padStart(2, '0');
  const s = String(STATE.timerSeconds % 60).padStart(2, '0');
  DOM.timerDisplay.textContent = m + ':' + s;
  DOM.timerDisplay.classList.toggle('warning', STATE.timerSeconds <= 120);
}

function toggleTimer() {
  STATE.isTimerRunning = !STATE.isTimerRunning;
  DOM.btnTimerToggle.textContent = STATE.isTimerRunning ? '⏸️' : '▶️';
}

function resetTimer() {
  startTimer();
}

function stopTimer() {
  clearInterval(STATE.timerInterval);
}

// ============================================================================
// UTILS
// ============================================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
