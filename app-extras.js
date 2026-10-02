function summarizeImportedSource(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.slice(0, 320) + (normalized.length > 320 ? '…' : '');
}

function updateImportPreview() {
  const preview = document.getElementById('task-file-summary');
  const clearBtn = document.getElementById('task-file-clear');
  if (!preview) return;

  if (!STATE.importedSourceName) {
    preview.textContent = 'Upload a .txt or .pdf file to tailor the roadmap from reference material.';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }

  preview.innerHTML = `<strong>${escapeHtml(STATE.importedSourceName)}</strong><br>${escapeHtml(STATE.importedSourceSummary || 'Imported reference ready.')}`;
  if (clearBtn) clearBtn.style.display = '';
}

function clearImportedSource() {
  STATE.importedSourceName = '';
  STATE.importedSourceText = '';
  STATE.importedSourceSummary = '';
  const input = document.getElementById('task-file-input');
  if (input) input.value = '';
  updateImportPreview();
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    throw new Error('PDF support is not loaded yet. Refresh and try again.');
  }

  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
}

async function handleImportedSource(file) {
  if (!file) {
    clearImportedSource();
    return;
  }

  const lowerName = file.name.toLowerCase();
  let rawText = '';

  if (lowerName.endsWith('.txt') || file.type === 'text/plain') {
    rawText = await file.text();
  } else if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') {
    rawText = await extractPdfText(file);
  } else {
    throw new Error('Please upload a .txt or .pdf file.');
  }

  const cleanedText = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!cleanedText) {
    throw new Error('Could not extract text from that file.');
  }

  STATE.importedSourceName = file.name;
  STATE.importedSourceText = cleanedText;
  STATE.importedSourceSummary = summarizeImportedSource(cleanedText);
  updateImportPreview();
  toast(`Imported ${file.name}`);
}

function buildRoadmapTask(goal) {
  const baseGoal = String(goal || '').trim();
  const sourceParts = [];

  if (STATE.importedSourceSummary) {
    sourceParts.push(`Reference file ${STATE.importedSourceName}: ${STATE.importedSourceSummary}`);
  }

  if (STATE.importedSourceText) {
    sourceParts.push(`Source excerpt: ${STATE.importedSourceText.slice(0, 420)}`);
  }

  if (!baseGoal && !sourceParts.length) return '';
  if (!sourceParts.length) return baseGoal;

  return [baseGoal || 'Study the uploaded material', ...sourceParts].join('\n\n');
}

function launchConfetti() {
  const layer = document.getElementById('confetti-layer');
  if (!layer) return;

  layer.innerHTML = '';
  const colors = ['#FDE047', '#38BDF8', '#4ADE80', '#F472B6', '#FB923C', '#FFFFFF'];
  const count = 48;

  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[index % colors.length];
    piece.style.setProperty('--dx', `${(Math.random() * 2 - 1) * 180}px`);
    piece.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 90}px`);
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    piece.style.setProperty('--delay', `${Math.random() * 0.25}s`);
    piece.style.width = `${6 + Math.random() * 8}px`;
    piece.style.height = `${10 + Math.random() * 10}px`;
    layer.appendChild(piece);
  }

  setTimeout(() => {
    layer.innerHTML = '';
  }, 4200);
}

function buildConciseRoadmapTitle(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Uploaded study material';

  const sentence = normalized.match(/^(.+?[.!?])(\s|$)/);
  const candidate = (sentence ? sentence[1] : normalized)
    .replace(/reference file.*$/i, '')
    .replace(/source excerpt.*$/i, '')
    .trim();
  const words = candidate.split(/\s+/).filter(Boolean).slice(0, 8);
  return words.join(' ').replace(/[.,;:]+$/g, '') || 'Uploaded study material';
}

let pomodoroUiTimer = null;

function formatPomodoroTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, '0');
  const remainder = String(safeSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function getPomodoroSourceNode() {
  if (STATE.currentNodeForModal >= 0 && STATE.roadmap[STATE.currentNodeForModal]) {
    return STATE.roadmap[STATE.currentNodeForModal];
  }

  const activeIndex = (STATE.nodeStatus || []).findIndex(status => status === 'active');
  if (activeIndex >= 0 && STATE.roadmap[activeIndex]) {
    return STATE.roadmap[activeIndex];
  }

  return STATE.roadmap[0] || null;
}

function renderPomodoroQr(trackerUrl) {
  const host = document.getElementById('pomodoro-qr');
  if (!host) return;
  if (host.dataset.renderedUrl === String(trackerUrl || '')) return;
  host.innerHTML = '';
  host.dataset.renderedUrl = String(trackerUrl || '');

  if (!trackerUrl) {
    host.innerHTML = '<div class="empty-state">QR code will appear here after the session starts.</div>';
    return;
  }

  if (!window.QRCode) {
    host.innerHTML = `<a href="${trackerUrl}" target="_blank" rel="noreferrer">Open tracker</a>`;
    return;
  }

  new window.QRCode(host, {
    text: trackerUrl,
    width: 180,
    height: 180,
    colorDark: '#0b1020',
    colorLight: '#fff7e6',
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function updatePomodoroUi(snapshot = STATE.pomodoroSession) {
  if (!snapshot) return;
  const remaining = snapshot.status === 'running'
    ? Math.max(0, Math.ceil((snapshot.endsAt - Date.now()) / 1000))
    : Number(snapshot.remainingSeconds || 0);

  const titleEl = document.getElementById('pomodoro-title');
  const subEl = document.getElementById('pomodoro-subtitle');
  const timeEl = document.getElementById('pomodoro-time');
  const statusEl = document.getElementById('pomodoro-status');
  const progressEl = document.getElementById('pomodoro-progress');
  const trackerEl = document.getElementById('pomodoro-tracker-link');
  const qrEl = document.getElementById('pomodoro-qr-code-link');

  if (titleEl) titleEl.textContent = snapshot.nodeTitle || 'Pomodoro';
  if (subEl) subEl.textContent = snapshot.task || 'Focus session';
  if (timeEl) timeEl.textContent = formatPomodoroTime(remaining);
  if (statusEl) statusEl.textContent = String(snapshot.status || 'running').toUpperCase();
  if (progressEl) progressEl.style.width = `${Math.max(0, Math.min(100, (snapshot.progress || 0) * 100))}%`;
  if (trackerEl) trackerEl.href = STATE.pomodoroTrackerUrl || '#';
  if (qrEl) qrEl.textContent = STATE.pomodoroTrackerUrl || '';

  const pauseBtn = document.getElementById('pomodoro-pause-btn');
  const resumeBtn = document.getElementById('pomodoro-resume-btn');
  const resetBtn = document.getElementById('pomodoro-reset-btn');

  if (pauseBtn) pauseBtn.style.display = snapshot.status === 'running' ? '' : 'none';
  if (resumeBtn) resumeBtn.style.display = snapshot.status === 'paused' ? '' : 'none';
  if (resetBtn) resetBtn.style.display = snapshot.status === 'completed' ? 'none' : '';

  renderPomodoroQr(STATE.pomodoroTrackerUrl);
}

function syncPomodoroUiTimer() {
  if (pomodoroUiTimer) clearInterval(pomodoroUiTimer);
  pomodoroUiTimer = setInterval(() => {
    if (STATE.pomodoroSession) updatePomodoroUi(STATE.pomodoroSession);
  }, 1000);
}

function setPomodoroSession(snapshot, trackerUrl) {
  STATE.pomodoroSession = snapshot || null;
  STATE.pomodoroToken = snapshot?.token || '';
  STATE.pomodoroTrackerUrl = trackerUrl || STATE.pomodoroTrackerUrl || '';
  if (!snapshot) {
    if (pomodoroUiTimer) clearInterval(pomodoroUiTimer);
    pomodoroUiTimer = null;
    const resetTime = document.getElementById('pomodoro-time');
    const resetStatus = document.getElementById('pomodoro-status');
    const resetProgress = document.getElementById('pomodoro-progress');
    const resetSubtitle = document.getElementById('pomodoro-subtitle');
    if (resetTime) resetTime.textContent = '25:00';
    if (resetStatus) resetStatus.textContent = 'READY';
    if (resetProgress) resetProgress.style.width = '0%';
    if (resetSubtitle) resetSubtitle.textContent = 'Scan the QR code on your phone to follow this timer live.';
    renderPomodoroQr('');
    return;
  }

  updatePomodoroUi(snapshot);
  if (snapshot.status === 'completed') {
    if (pomodoroUiTimer) clearInterval(pomodoroUiTimer);
    pomodoroUiTimer = null;
    return;
  }

  syncPomodoroUiTimer();
}

function openPomodoroModal() {
  const modal = document.getElementById('modal-pomodoro');
  if (modal) modal.classList.add('show');
  updatePomodoroUi(STATE.pomodoroSession);
}

function closePomodoroModal() {
  const modal = document.getElementById('modal-pomodoro');
  if (modal) modal.classList.remove('show');
}

async function startPomodoroSession() {
  if (STATE.pomodoroBusy) return;
  const sourceNode = getPomodoroSourceNode();
  if (!sourceNode) {
    toast('Open a roadmap step first.');
    return;
  }
  if (!STATE.currentRoadmapId) {
    toast('Open a roadmap before starting a focus session.');
    return;
  }

  STATE.pomodoroBusy = true;
  try {
    const res = await fetch('/api/pomodoro/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        roadmapId: STATE.currentRoadmapId,
        task: STATE.task,
        nodeTitle: sourceNode.title || STATE.task || 'Pomodoro',
        durationMinutes: 25,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    setPomodoroSession(data.snapshot, data.trackerUrl);
    openPomodoroModal();
    toast('Pomodoro session started. Scan the QR code on your phone.');
  } catch (error) {
    toast(`Pomodoro start failed: ${error.message}`, 3200);
  } finally {
    STATE.pomodoroBusy = false;
  }
}

async function sendPomodoroAction(action) {
  if (!STATE.pomodoroToken) {
    toast('Start a pomodoro session first.');
    return;
  }

  try {
    const res = await fetch(`/api/pomodoro/${STATE.pomodoroToken}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setPomodoroSession(data.snapshot, STATE.pomodoroTrackerUrl);
  } catch (error) {
    toast(`Pomodoro update failed: ${error.message}`, 3200);
  }
}

async function refreshPomodoroSession() {
  if (!STATE.pomodoroToken) return;
  try {
    const res = await fetch(`/api/pomodoro/${STATE.pomodoroToken}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setPomodoroSession(data.snapshot, STATE.pomodoroTrackerUrl);
  } catch {
    // Best effort only.
  }
}
