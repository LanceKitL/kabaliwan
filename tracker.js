const state = {
  token: '',
  socket: null,
  snapshot: null,
  reconnectTimer: null,
  tickTimer: null,
};

function qs(id) {
  return document.getElementById(id);
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, '0');
  const remainder = String(safeSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function setError(message) {
  const box = qs('error-box');
  if (!box) return;
  if (!message) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = 'block';
  box.textContent = message;
}

function render(snapshot) {
  if (!snapshot) return;
  state.snapshot = snapshot;
  const remaining = snapshot.status === 'running'
    ? Math.max(0, Math.ceil((snapshot.endsAt - Date.now()) / 1000))
    : Number(snapshot.remainingSeconds || 0);
  const duration = snapshot.durationSeconds || 1500;
  const progress = snapshot.progress != null ? snapshot.progress : (duration ? 1 - remaining / duration : 0);

  qs('session-title').textContent = snapshot.nodeTitle || 'Pomodoro';
  qs('session-sub').textContent = snapshot.task || 'Focus session';
  qs('time-left').textContent = formatTime(remaining);
  qs('session-status').textContent = String(snapshot.status || 'running').toUpperCase();
  qs('roadmap-label').textContent = snapshot.roadmapId ? `Roadmap #${snapshot.roadmapId}` : 'No roadmap bound';
  qs('task-label').textContent = snapshot.task || '-';
  qs('progress-fill').style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;

  if (snapshot.status === 'completed') {
    qs('session-status').textContent = 'COMPLETE';
  }
}

function startLocalTick() {
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.tickTimer = setInterval(() => {
    if (!state.snapshot) return;
    render(state.snapshot);
    if (state.snapshot.status === 'completed') {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
  }, 1000);
}

function connect() {
  if (!state.token) return;
  if (state.socket) {
    try { state.socket.close(); } catch {}
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws/pomodoro?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  setError('');

  socket.addEventListener('open', () => {
    setError('');
  });

  socket.addEventListener('message', event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload && payload.snapshot) {
        render(payload.snapshot);
      }
    } catch {
      setError('Received an unreadable tracker update.');
    }
  });

  socket.addEventListener('close', () => {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connect, 2000);
  });

  socket.addEventListener('error', () => {
    setError('Tracker connection issue. Retrying...');
  });
}

async function bootstrap() {
  const params = new URLSearchParams(location.search);
  state.token = params.get('token') || '';
  if (!state.token) {
    setError('Missing tracker token. Open the QR code from Zebri to join the live session.');
    qs('session-status').textContent = 'NO TOKEN';
    return;
  }

  try {
    const res = await fetch(`/api/pomodoro/${encodeURIComponent(state.token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    render(data.snapshot);
    startLocalTick();
    connect();
  } catch (error) {
    setError(error.message || 'Failed to load tracker session.');
  }
}

bootstrap();
