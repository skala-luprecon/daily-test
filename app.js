/**
 * Daily Test CBT Arena - Application Logic (Vanilla JS)
 */

const STATE = {
  subject: 'toeic', // 'toeic' | 'skct'
  date: '2026-08-31',
  availableDates: ['2026-08-31'],
  quizData: null,
  userAnswers: {}, // { Q_ID: optionIndex }
  isSubmitted: false,
  startTime: null,
  timerSeconds: 15 * 60,
  timerInterval: null,
  isTimerRunning: true,
  filterMode: 'all' // 'all' | 'wrong'
};

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadManifest();
  await loadQuiz(STATE.subject, STATE.date);
});

function setupEventListeners() {
  // Subject Tabs
  document.getElementById('tab-toeic').addEventListener('click', () => switchSubject('toeic'));
  document.getElementById('tab-skct').addEventListener('click', () => switchSubject('skct'));

  // Date Selector
  document.getElementById('date-select').addEventListener('change', (e) => {
    STATE.date = e.target.value;
    loadQuiz(STATE.subject, STATE.date);
  });

  // Submit Buttons
  document.getElementById('btn-submit-bottom').addEventListener('click', handleSubmit);
  document.getElementById('btn-submit-sidebar').addEventListener('click', handleSubmit);

  // Timer Controls
  document.getElementById('btn-timer-toggle').addEventListener('click', toggleTimer);
  document.getElementById('btn-timer-reset').addEventListener('click', resetTimer);

  // Post-Submit Filters
  document.getElementById('btn-filter-all').addEventListener('click', () => setFilterMode('all'));
  document.getElementById('btn-filter-wrong').addEventListener('click', () => setFilterMode('wrong'));
  document.getElementById('btn-retake').addEventListener('click', handleRetake);
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
        STATE.date = data.latest || data.dates[0];
      }
    }
  } catch (err) {
    console.warn('Manifest load fallback:', err);
  }
  populateDateDropdown();
}

function populateDateDropdown() {
  const select = document.getElementById('date-select');
  select.innerHTML = '';
  STATE.availableDates.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    if (d === STATE.date) opt.selected = true;
    select.appendChild(opt);
  });
}

async function switchSubject(subject) {
  if (STATE.subject === subject) return;
  STATE.subject = subject;

  document.getElementById('tab-toeic').classList.toggle('active', subject === 'toeic');
  document.getElementById('tab-skct').classList.toggle('active', subject === 'skct');

  await loadQuiz(STATE.subject, STATE.date);
}

async function loadQuiz(subject, date) {
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
    document.getElementById('questions-list').innerHTML = 
      '<div class="question-card" style="text-align: center; padding: 3rem;">' +
        '<h3>⚠️ 데이터를 불러올 수 없습니다.</h3>' +
        '<p style="color: #64748b; margin-top: 0.5rem;">경로: ' + filePath + '</p>' +
      '</div>';
  }
}

function resetQuizState() {
  STATE.userAnswers = {};
  STATE.isSubmitted = false;
  STATE.startTime = Date.now();
  STATE.filterMode = 'all';
  document.getElementById('score-hero').classList.add('hidden');
  document.getElementById('btn-submit-bottom').style.display = 'flex';
  document.getElementById('btn-submit-sidebar').style.display = 'flex';
  updateProgress();
}

// ============================================================================
// RENDERING
// ============================================================================
function renderQuiz() {
  const quiz = STATE.quizData;
  if (!quiz) return;

  // Header badges
  document.getElementById('test-title').textContent = quiz.title || (quiz.type === 'TOEIC' ? 'TOEIC RC 실전 평가' : 'SKCT 인지역량 평가');
  document.getElementById('test-date-badge').textContent = quiz.date;
  document.getElementById('test-count-badge').textContent = '총 ' + quiz.questions.length + '문항';
  document.getElementById('test-model-badge').textContent = quiz.model || 'gemini-3.6-flash';

  // Question List
  const container = document.getElementById('questions-list');
  container.innerHTML = '';

  let lastPart = '';

  quiz.questions.forEach((q) => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = 'card-' + q.id;

    // Part header if changed
    let partHeaderHtml = '';
    if (q.part && q.part !== lastPart) {
      partHeaderHtml = '<div class="card-part-header">📖 ' + escapeHtml(q.part) + '</div>';
      lastPart = q.part;
    }

    // Scenario box
    let scenarioHtml = '';
    if (q.scenario) {
      const cleanScenario = String(q.scenario).replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      scenarioHtml = 
        '<div class="scenario-box">' +
          '<pre>' + escapeHtml(cleanScenario) + '</pre>' +
        '</div>';
    }

    // Options
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
      partHeaderHtml +
      scenarioHtml +
      '<div class="question-title-row">' +
        '<span class="question-num-badge">' + q.number + '번</span>' +
        '<h3 class="question-text">' + escapeHtml(q.question) + '</h3>' +
      '</div>' +
      '<div class="options-list" id="opts-' + q.id + '">' +
        optionsHtml +
      '</div>' +
      '<div class="explanation-slot" id="expl-' + q.id + '"></div>';

    container.appendChild(card);
  });

  // Attach Option Click Handlers
  container.querySelectorAll('.option-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (STATE.isSubmitted) return;
      const qid = el.getAttribute('data-qid');
      const optIdx = parseInt(el.getAttribute('data-opt'), 10);
      selectOption(qid, optIdx);
    });
  });

  renderOmrGrid();
  updateProgress();
}

function selectOption(qid, optIdx) {
  STATE.userAnswers[qid] = optIdx;

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
  const grid = document.getElementById('omr-grid');
  grid.innerHTML = '';

  if (!STATE.quizData) return;

  STATE.quizData.questions.forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'omr-btn ' + (STATE.userAnswers[q.id] !== undefined ? 'answered' : '');
    btn.id = 'omr-' + q.id;
    btn.textContent = q.number;
    btn.title = q.number + '번 문제로 이동';

    btn.addEventListener('click', () => {
      const card = document.getElementById('card-' + q.id);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    grid.appendChild(btn);
  });
}

function updateProgress() {
  if (!STATE.quizData) return;
  const total = STATE.quizData.questions.length;
  const answered = Object.keys(STATE.userAnswers).length;
  const pct = Math.round((answered / total) * 100);

  document.getElementById('progress-text').textContent = answered + ' / ' + total + ' 완료 (' + pct + '%)';
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('omr-count-status').textContent = answered + ' / ' + total;
}

// ============================================================================
// SUBMISSION & SCORING
// ============================================================================
function handleSubmit() {
  if (STATE.isSubmitted) return;

  const total = STATE.quizData.questions.length;
  const answered = Object.keys(STATE.userAnswers).length;

  if (answered < total) {
    const unansweredCount = total - answered;
    const confirm = window.confirm('아직 풀지 않은 문제가 ' + unansweredCount + '개 있습니다. 그래도 제출하시겠습니까?');
    if (!confirm) return;
  }

  STATE.isSubmitted = true;
  stopTimer();

  // Calculate Scores
  let correctCount = 0;
  STATE.quizData.questions.forEach((q) => {
    const userAns = STATE.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;
    if (isCorrect) correctCount++;

    // OMR button update
    const omrBtn = document.getElementById('omr-' + q.id);
    if (omrBtn) {
      omrBtn.classList.remove('answered');
      omrBtn.classList.add(isCorrect ? 'correct' : 'wrong');
    }

    // Question card explanation injection
    renderQuestionExplanation(q, userAns, isCorrect);
  });

  // Calculate Stats
  const pct = Math.round((correctCount / total) * 100);
  const elapsedSeconds = Math.round((Date.now() - STATE.startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');

  document.getElementById('stat-score').textContent = correctCount + ' / ' + total;
  document.getElementById('stat-accuracy').textContent = pct + '%';
  document.getElementById('stat-time').textContent = minutes + '분 ' + seconds + '초';

  let grade = '수고하셨습니다! 👍';
  if (pct === 100) grade = '만점! 상위 1% 킬러 정복 🏆';
  else if (pct >= 85) grade = '우수! 상위 10% 실력자 🔥';
  else if (pct >= 70) grade = '안정권! 합격 안정 점수 🎯';
  document.getElementById('score-grade-badge').textContent = grade;

  // Show Hero and Hide Submit buttons
  document.getElementById('score-hero').classList.remove('hidden');
  document.getElementById('btn-submit-bottom').style.display = 'none';
  document.getElementById('btn-submit-sidebar').style.display = 'none';

  // Scroll to score card
  document.getElementById('score-hero').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        '<div class="expl-box" style="background: #ffffff; border: 1px solid #e2e8f0;">' +
          '<strong>🔍 [선택지별 분석]</strong>' +
          '<div class="option-expl-list" style="margin-top: 0.4rem;">' +
            optExplsHtml +
          '</div>' +
        '</div>' : '') +
    '</div>';
}

function setFilterMode(mode) {
  STATE.filterMode = mode;
  document.getElementById('btn-filter-all').classList.toggle('active', mode === 'all');
  document.getElementById('btn-filter-wrong').classList.toggle('active', mode === 'wrong');

  if (!STATE.quizData) return;

  STATE.quizData.questions.forEach((q) => {
    const card = document.getElementById('card-' + q.id);
    if (!card) return;

    const userAns = STATE.userAnswers[q.id];
    const isCorrect = userAns === q.answerIndex;

    if (mode === 'wrong' && isCorrect) {
      card.style.display = 'none';
    } else {
      card.style.display = 'block';
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
  const defaultMinutes = STATE.subject === 'toeic' ? 15 : 12;
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
  const el = document.getElementById('timer-display');
  el.textContent = m + ':' + s;
  el.classList.toggle('warning', STATE.timerSeconds <= 120);
}

function toggleTimer() {
  STATE.isTimerRunning = !STATE.isTimerRunning;
  document.getElementById('btn-timer-toggle').textContent = STATE.isTimerRunning ? '⏸️' : '▶️';
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
