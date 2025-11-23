/*  Orion Multi-Agent Frontend — Enhanced for Refactored Architecture  */

/* ========== 0. Helpers ========== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (text) => {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
};

/* ========== 1. Wait for libs ========== */
let libsReady = false;
function waitLibs() {
  return new Promise((res) => {
    const t = setInterval(() => {
      if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
        clearInterval(t);
        libsReady = true;
        res();
      }
    }, 60);
  });
}

/* ========== 2. DOM cache ========== */
const $ = (id) => document.getElementById(id);
const chatContainer = $('messages-area');
const chatMessages = $('messages-wrapper');
const welcomeScreen = $('welcome-message');
const userInput = $('chat-input');
const sendButton = $('send-button');
const typingIndicator = $('typing-indicator');
const typingText = $('typing-text');
const fileInput = $('file-input');
const filePreview = $('file-preview');
const sidebar = $('sidebar');
const menuBtn = $('menu-btn');
const overlay = $('overlay');
const userInfo = $('user-info');
const workerActivity = $('worker-activity');
const workerActivityText = $('worker-activity-text');
const artifactsPanel = $('artifacts-panel');
const artifactsList = $('artifacts-list');

/* ========== 3. State ========== */
let ws = null,
  isConnecting = false,
  reconnectAttempts = 0;
let isProcessing = false,
  currentMessageEl = null;
let pendingFiles = [],
  conversationStarted = false;
let isNewSession = false;
const MAX_RECONNECT_DELAY = 30000;

// Session management
let currentSessionId = null;
let sessions = [];

// Worker tracking
let activeWorker = null;
let workerStartTime = null;

// Artifacts
let artifacts = [];
let currentArtifactContent = null;

/* ========== 4. Init ========== */
window.addEventListener('DOMContentLoaded', async () => {
  await waitLibs();
  configureMarked();

  await initializeSession();
  setupFileUpload();
  setupInputHandlers();
  setupSidebarToggle();
  checkMobileView();

  await loadSessionsList();
  await loadArtifacts();
});

window.addEventListener('resize', checkMobileView);
window.addEventListener('beforeunload', () => {
  if (ws) try { ws.close(); } catch {}
});

/* ========== 5. Session Management ========== */
async function initializeSession() {
  const storedSessionId = localStorage.getItem('currentSessionId');

  if (storedSessionId) {
    try {
      const response = await fetch(`/api/sessions/${storedSessionId}`);
      if (response.ok) {
        currentSessionId = storedSessionId;
        console.log('Restored session:', currentSessionId);
        await loadChatHistory();
        connectWebSocket();
        updateUserInfo();
        return;
      }
    } catch (e) {
      console.log('Failed to restore session, creating new one', e);
    }
  }

  await createNewSession();
}

async function createNewSession(title = 'New Session') {
  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      throw new Error('Failed to create session');
    }

    const session = await response.json();
    currentSessionId = session.sessionId || session.id || session.session_id;

    if (!currentSessionId) throw new Error('Missing session id in response');

    localStorage.setItem('currentSessionId', currentSessionId);
    console.log('Created new session:', currentSessionId);

    isNewSession = true;
    artifacts = [];
    updateUserInfo();
    connectWebSocket();
    await loadSessionsList();

    return session;
  } catch (e) {
    console.error('Failed to create session:', e);
    addToast('Failed to create session', 'error');
    throw e;
  }
}

async function loadSessionsList() {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;

    const data = await response.json();
    sessions = data.sessions || [];

    renderSessionsList();
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
}

function renderSessionsList() {
  const container = $('sessions-list');
  if (!container) return;

  container.innerHTML = '';

  sessions.forEach((session) => {
    const id = session.sessionId || session.id;
    const title = session.title || session.name || 'New Session';
    const messageCount = session.messageCount || 0;
    
    const li = document.createElement('li');
    li.className = `p-2 text-sm rounded-lg hover:bg-gray-800 transition-colors cursor-pointer truncate ${
      id === currentSessionId ? 'bg-gray-800 text-white' : 'text-gray-400'
    }`;
    
    li.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="truncate flex-1">${escapeHtml(title)}</span>
        <span class="text-xs text-gray-500">${messageCount}</span>
        <button onclick="deleteSession('${id}')" class="text-red-400 hover:text-red-300 p-1">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    `;
    
    li.addEventListener('click', (e) => {
      if (!e.target.closest('button')) {
        switchToSession(id);
      }
    });
    
    container.appendChild(li);
  });
}

async function switchToSession(sessionId) {
  if (sessionId === currentSessionId) return;

  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  if (chatMessages) chatMessages.innerHTML = '';
  conversationStarted = false;
  welcomeScreen?.classList.remove('hidden');
  artifacts = [];
  activeWorker = null;
  hideWorkerActivity();

  currentSessionId = sessionId;
  localStorage.setItem('currentSessionId', sessionId);

  updateUserInfo();
  await loadChatHistory();
  await loadArtifacts();
  connectWebSocket();

  if (window.innerWidth <= 768 && sidebar && overlay) {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  }
}

window.deleteSession = async function (id) {
  event.stopPropagation();
  if (!confirm('Delete this session? This action cannot be undone.')) return;

  try {
    const response = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete session');

    if (id === currentSessionId) {
      await createNewSession();
    }

    await loadSessionsList();
    addToast('Session deleted', 'success');
  } catch (e) {
    console.error('Failed to delete session:', e);
    addToast('Failed to delete session', 'error');
  }
};

async function generateSessionTitle() {
  if (!currentSessionId) return;
  
  try {
    // Use first user message as title
    const messages = chatMessages?.querySelectorAll('.message-content') || [];
    if (messages.length > 0) {
      const firstMsg = messages[0].textContent.slice(0, 50);
      const title = firstMsg + (firstMsg.length >= 50 ? '...' : '');
      await updateSessionTitle(title);
    }
  } catch (e) {
    console.error('Failed to generate title:', e);
  }
}

async function updateSessionTitle(title) {
  try {
    const response = await fetch(`/api/sessions/${currentSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    
    if (response.ok) {
      await loadSessionsList();
    }
  } catch (e) {
    console.error('Failed to update title:', e);
  }
}

function updateUserInfo() {
  if (userInfo && currentSessionId) {
    userInfo.innerHTML = `
      <div class="text-xs">Session: <span class="text-teal-400">${currentSessionId.slice(0, 8)}...</span></div>
      <div class="text-xs text-gray-500 mt-1">Artifacts: ${artifacts.length}</div>
    `;
  }
}

/* ========== 6. Artifacts Management ========== */
async function loadArtifacts() {
  if (!currentSessionId) return;

  try {
    const response = await fetch(`/api/artifacts?session_id=${encodeURIComponent(currentSessionId)}`);
    if (!response.ok) return;

    const data = await response.json();
    artifacts = data.artifacts || [];
    
    renderArtifacts();
    updateUserInfo();
  } catch (e) {
    console.error('Failed to load artifacts:', e);
  }
}

function renderArtifacts() {
  if (!artifactsList) return;

  if (artifacts.length === 0) {
    artifactsPanel?.classList.add('hidden');
    return;
  }

  artifactsPanel?.classList.remove('hidden');
  artifactsList.innerHTML = '';

  artifacts.forEach((artifact) => {
    const item = document.createElement('div');
    item.className = 'p-2 bg-white/5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer border border-white/10';
    
    const typeIcons = {
      research: '🔍',
      analysis: '📊',
      content: '📝',
      code: '💻',
      report: '📄',
      data: '📈',
    };
    
    const icon = typeIcons[artifact.type] || '📎';
    
    item.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-lg">${icon}</span>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-white truncate">${escapeHtml(artifact.title)}</div>
          <div class="text-xs text-gray-500">${artifact.type}</div>
        </div>
      </div>
    `;
    
    item.addEventListener('click', () => viewArtifact(artifact));
    artifactsList.appendChild(item);
  });
}

function viewArtifact(artifact) {
  const modal = $('artifact-modal');
  const titleEl = $('artifact-modal-title');
  const contentEl = $('artifact-modal-content');
  
  if (!modal || !titleEl || !contentEl) return;

  titleEl.textContent = artifact.title;
  contentEl.innerHTML = marked.parse(artifact.content);
  contentEl.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  
  currentArtifactContent = artifact.content;
  modal.classList.remove('hidden');
}

window.closeArtifactModal = function() {
  const modal = $('artifact-modal');
  if (modal) modal.classList.add('hidden');
  currentArtifactContent = null;
};

window.copyArtifactContent = function() {
  if (!currentArtifactContent) return;
  
  navigator.clipboard.writeText(currentArtifactContent)
    .then(() => addToast('Content copied!', 'success'))
    .catch(() => addToast('Failed to copy', 'error'));
};

/* ========== 7. Marked Config ========== */
function configureMarked() {
  marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {}
      }
      return hljs.highlightAuto(code).value;
    },
  });
}

/* ========== 8. WebSocket ========== */
async function connectWebSocket() {
  if (!currentSessionId) {
    console.error('Cannot connect WebSocket without session ID');
    return;
  }

  if ((ws && ws.readyState === WebSocket.OPEN) || isConnecting) return;

  isConnecting = true;
  updateConnectionStatus('Connecting…', 'bg-gray-500');

  const origin = location.origin.replace(/^http/, 'ws');
  const url = `${origin}/api/ws?session_id=${encodeURIComponent(currentSessionId)}`;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('WS create error', e);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnecting = false;
    reconnectAttempts = 0;
    updateConnectionStatus('Connected', 'bg-teal-500');
  };

  ws.onclose = () => {
    isConnecting = false;
    updateConnectionStatus('Disconnected', 'bg-red-500');
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('WS error', e);
    updateConnectionStatus('Error', 'bg-red-500');
  };

  ws.onmessage = (e) => {
    try {
      handleServerMessage(JSON.parse(e.data));
    } catch (err) {
      console.error('Bad json', err, e.data);
    }
  };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts++), MAX_RECONNECT_DELAY);
  setTimeout(() => {
    if (currentSessionId) connectWebSocket();
  }, delay);
}

/* ========== 9. Mobile ========== */
function checkMobileView() {
  const mobile = window.innerWidth <= 768;
  if (mobile && sidebar && overlay) {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  }
}

function setupSidebarToggle() {
  menuBtn?.addEventListener('click', () => {
    sidebar?.classList.toggle('-translate-x-full');
    overlay?.classList.toggle('hidden');
  });

  overlay?.addEventListener('click', () => {
    sidebar?.classList.add('-translate-x-full');
    overlay?.classList.add('hidden');
  });
}

/* ========== 10. File upload ========== */
function setupFileUpload() {
  const attachBtn = $('attach-file-button');
  if (attachBtn) {
    attachBtn.addEventListener('click', () => {
      fileInput?.click();
      $('tools-popup')?.classList.add('pointer-events-none');
    });
  }

  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        addToast(`${file.name} too large (max 20MB)`, 'error');
        continue;
      }
      try {
        const base64 = await fileToBase64(file);
        pendingFiles.push({
          data: base64.split(',')[1],
          mimeType: file.type,
          name: file.name,
          size: file.size,
        });
        addFileChip(file);
        addToast(`Added ${file.name}`, 'success');
      } catch {
        addToast(`Failed to add ${file.name}`, 'error');
      }
    }
    fileInput.value = '';
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function addFileChip(file) {
  if (!filePreview) return;
  const chip = document.createElement('div');
  chip.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs text-white';
  chip.dataset.fileName = file.name;
  chip.innerHTML = `
    <span>${getFileIcon(file.type, file.name)}</span>
    <span class="truncate max-w-[150px]">${escapeHtml(file.name)}</span>
    <span class="text-gray-400">(${formatFileSize(file.size)})</span>
    <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" aria-label="Remove file">
      <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
      </svg>
    </button>`;
  filePreview.appendChild(chip);

  const btn = chip.querySelector('button');
  btn?.addEventListener('click', () => removeFileChip(file.name));
}

window.removeFileChip = function (name) {
  pendingFiles = pendingFiles.filter((f) => f.name !== name);
  document.querySelectorAll(`[data-file-name="${CSS.escape(name)}"]`).forEach((el) => el.remove());
};

function formatFileSize(b) {
  return b < 1024
    ? b + ' B'
    : b < 1048576
    ? (b / 1024).toFixed(1) + ' KB'
    : (b / 1048576).toFixed(1) + ' MB';
}

function getFileIcon(mime, name) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return '📝';
  if (mime.includes('sheet') || name.endsWith('.csv') || name.endsWith('.xlsx')) return '📊';
  if (mime.includes('json')) return '📋';
  if (mime.includes('text')) return '📃';
  return '📎';
}

/* ========== 11. Input ========== */
function setupInputHandlers() {
  const form = $('chat-form');

  if (userInput) {
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });
  }

  const toolsBtn = $('tools-btn');
  const toolsPopup = $('tools-popup');
  if (toolsBtn && toolsPopup) {
    toolsBtn.addEventListener('click', () => {
      toolsPopup.classList.toggle('pointer-events-none');
      toolsPopup.classList.toggle('opacity-0');
      toolsPopup.classList.toggle('translate-y-2');
    });

    document.addEventListener('click', (e) => {
      if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) {
        toolsPopup.classList.add('pointer-events-none', 'opacity-0', 'translate-y-2');
      }
    });
  }
}

/* ========== 12. Send ========== */
async function sendMessage() {
  const msg = (userInput?.value || '').trim();
  if ((msg === '' && pendingFiles.length === 0) || isProcessing) return;

  if (!currentSessionId) {
    addToast('No active session', 'error');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addToast('Connecting…', 'info');
    connectWebSocket();
    await sleep(1200);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addToast('Still connecting – please retry', 'error');
      return;
    }
  }

  isProcessing = true;
  disableInput();
  hideWelcome();
  addUserMessage(msg || 'Sent files for analysis.');
  if (userInput) userInput.value = '';
  if (userInput) userInput.style.height = 'auto';
  showTypingIndicator('Processing…');

  try {
    const payload = {
      type: 'user_message',
      content: msg,
      files: pendingFiles.length ? pendingFiles : undefined,
    };
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('send error', e);
    addToast('Send failed – please retry', 'error');
    isProcessing = false;
    enableInput(true);
    hideTypingIndicator();
  }
}

/* ========== 13. Server messages ========== */
function handleServerMessage(d) {
  console.log('Server message:', d.type, d);

  switch (d.type) {
    case 'status':
      updateTypingIndicator(d.message || 'Processing...');
      break;

    case 'chunk':
      if (!currentMessageEl) {
        hideWelcome();
        currentMessageEl = createMessageElement('assistant');
      }
      appendToMessage(currentMessageEl, d.content);
      scrollToBottom(true);
      break;

    case 'worker_started':
      handleWorkerStarted(d);
      break;

    case 'worker_progress':
      handleWorkerProgress(d);
      break;

    case 'worker_completed':
      handleWorkerCompleted(d);
      break;

    case 'artifact':
      handleArtifact(d);
      break;

    case 'complete':
      hideTypingIndicator();
      hideWorkerActivity();
      if (currentMessageEl) finalizeMessage(currentMessageEl);
      currentMessageEl = null;
      activeWorker = null;
      isProcessing = false;
      enableInput(false);
      scrollToBottom(true);
      pendingFiles = [];
      if (filePreview) filePreview.innerHTML = '';
      if (isNewSession) {
        isNewSession = false;
        generateSessionTitle();
      }
      break;

    case 'error':
      hideTypingIndicator();
      hideWorkerActivity();
      addToast(`Error: ${d.message || d.error || 'Unknown error'}`, 'error');
      currentMessageEl = null;
      activeWorker = null;
      isProcessing = false;
      enableInput(true);
      break;

    default:
      console.warn('Unknown server message type:', d.type, d);
      break;
  }
}

/* ========== 14. Worker Activity ========== */
function handleWorkerStarted(data) {
  activeWorker = data.worker;
  workerStartTime = Date.now();
  showWorkerActivity(`${data.worker} starting...`);
  updateTypingIndicator(`Delegating to ${data.worker}...`);
}

function handleWorkerProgress(data) {
  if (data.progress !== undefined) {
    showWorkerActivity(`${data.worker} - ${data.progress}%`);
  } else if (data.message) {
    showWorkerActivity(data.message);
  }
  updateTypingIndicator(data.message || 'Worker processing...');
}

function handleWorkerCompleted(data) {
  const duration = workerStartTime ? ((Date.now() - workerStartTime) / 1000).toFixed(1) : '?';
  showWorkerActivity(`${data.worker} completed (${duration}s)`);
  
  setTimeout(() => {
    hideWorkerActivity();
    activeWorker = null;
    workerStartTime = null;
  }, 2000);
}

function showWorkerActivity(message) {
  if (!workerActivity || !workerActivityText) return;
  workerActivityText.textContent = message;
  workerActivity.classList.remove('hidden');
}

function hideWorkerActivity() {
  if (!workerActivity) return;
  workerActivity.classList.add('hidden');
}

function handleArtifact(data) {
  if (!data.artifact) return;
  
  artifacts.push(data.artifact);
  renderArtifacts();
  updateUserInfo();
  
  // Show artifact notification in current message
  if (currentMessageEl) {
    const content = currentMessageEl.querySelector('.message-content');
    if (content) {
      const artifactNotice = document.createElement('div');
      artifactNotice.className = 'mt-3 p-3 artifact-badge rounded-lg text-white text-sm flex items-center gap-2';
      artifactNotice.innerHTML = `
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span>Created: <strong>${escapeHtml(data.artifact.title)}</strong> (${data.artifact.type})</span>
      `;
      artifactNotice.style.cursor = 'pointer';
      artifactNotice.addEventListener('click', () => viewArtifact(data.artifact));
      content.appendChild(artifactNotice);
    }
  }
  
  addToast(`Artifact created: ${data.artifact.type}`, 'success');
}

/* ========== 15. Message DOM ========== */
function createMessageElement(role) {
  const isUser = role === 'user';
  const wrap = document.createElement('div');
  wrap.className = 'py-4 px-4 md:px-6 ' + (isUser ? '' : 'bg-[#1e1e1e]');

  const el = document.createElement('div');
  el.className = 'flex items-start gap-4 max-w-4xl mx-auto';
  el.innerHTML = `
    <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${
      isUser ? 'bg-gray-500' : 'bg-teal-600'
    }">
      ${isUser ? '👤' : `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m0 0v8m0 0h4m-4 0H8"/></svg>`}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold mb-2 ${isUser ? 'text-gray-300' : 'text-teal-400'}">${isUser ? 'You' : 'Orion'}</h3>
      <div class="message-content text-gray-200"></div>
    </div>`;

  wrap.appendChild(el);
  chatMessages?.appendChild(wrap);
  return el;
}

function appendToMessage(el, txt) {
  const content = el.querySelector('.message-content');
  if (!content) return;
  if (!content.dataset.streaming) {
    content.dataset.streaming = 'true';
    content.dataset.rawContent = '';
  }
  content.dataset.rawContent += txt;
  content.textContent = content.dataset.rawContent;
}

function finalizeMessage(el) {
  const content = el.querySelector('.message-content');
  if (!content) return;
  const raw = content.dataset.rawContent || content.textContent;
  content.innerHTML = marked.parse(raw);
  content.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  delete content.dataset.streaming;
  delete content.dataset.rawContent;
}

function addUserMessage(txt, scroll = true) {
  const el = createMessageElement('user');
  el.querySelector('.message-content').textContent = txt;
  if (scroll) scrollToBottom(true);
}

function addAssistantMessage(txt, scroll = true) {
  const el = createMessageElement('assistant');
  el.querySelector('.message-content').innerHTML = marked.parse(txt);
  el.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  if (scroll) scrollToBottom(false);
}

/* ========== 16. Typing ========== */
function showTypingIndicator(msg = 'Thinking…') {
  if (!typingText || !typingIndicator) return;
  typingText.innerHTML = `<div class="flex items-center gap-2"><span>${escapeHtml(msg)}</span></div>`;
  typingIndicator.classList.remove('hidden');
  scrollToBottom(true);
}

function updateTypingIndicator(msg) {
  if (!typingText) return;
  typingText.innerHTML = `<div class="flex items-center gap-2"><span>${escapeHtml(msg)}</span></div>`;
}

function hideTypingIndicator() {
  typingIndicator?.classList.add('hidden');
}

/* ========== 17. Input lock ========== */
function disableInput() {
  if (userInput) userInput.disabled = true;
  if (sendButton) sendButton.disabled = true;
}

function enableInput(focus = true) {
  if (userInput) userInput.disabled = false;
  if (sendButton) sendButton.disabled = false;
  if (focus && userInput) userInput.focus();
}

/* ========== 18. Scroll ========== */
function scrollToBottom(smooth = false) {
  const container = $('messages-area');
  if (container) {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
}

/* ========== 19. Connection status ========== */
function updateConnectionStatus(txt, cls) {
  const indicator = $('status-indicator');
  const statusText = $('status-text');
  const dot = indicator?.querySelector('.w-2.h-2');

  if (dot) {
    dot.className = `w-2 h-2 rounded-full ml-2 ${cls}`;
  }

  if (statusText) {
    statusText.textContent = txt;
    statusText.className =
      cls === 'bg-teal-500' ? 'text-teal-400' : cls === 'bg-red-500' ? 'text-red-400' : 'text-gray-400';
  }
}

/* ========== 20. Toast ========== */
function addToast(msg, type = 'info') {
  const colors = {
    error: 'bg-red-600',
    success: 'bg-teal-600',
    info: 'bg-blue-600',
  };

  const t = document.createElement('div');
  t.className = `fixed bottom-5 right-5 p-3 rounded-lg shadow-xl z-50 text-white text-sm transition transform translate-x-full opacity-0 ${colors[type] || colors.info}`;
  t.textContent = msg;
  document.body.appendChild(t);

  setTimeout(() => t.classList.remove('translate-x-full', 'opacity-0'), 10);
  setTimeout(() => {
    t.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

/* ========== 21. History ========== */
async function loadChatHistory() {
  if (!currentSessionId) return;

  try {
    const response = await fetch(`/api/history?session_id=${encodeURIComponent(currentSessionId)}`);
    if (!response.ok) return;

    const data = await response.json();
    if (data.messages?.length) {
      hideWelcome();
      data.messages.forEach((m) => {
        const role = m.role === 'model' ? 'assistant' : 'user';
        const text = (m.parts || []).filter((p) => p.text).map((p) => p.text).join('\n');
        if (text) {
          role === 'user' ? addUserMessage(text, false) : addAssistantMessage(text, false);
        }
      });
      scrollToBottom(false);
    }
  } catch (e) {
    console.error('history', e);
  }
}

/* ========== 22. Clear ========== */
window.clearChat = async function () {
  if (!confirm('Start a new chat? This will create a fresh session.')) return;

  try {
    await createNewSession('New Chat');

    if (chatMessages) chatMessages.innerHTML = '';
    pendingFiles = [];
    if (filePreview) filePreview.innerHTML = '';
    conversationStarted = false;
    artifacts = [];
    activeWorker = null;
    hideWorkerActivity();

    welcomeScreen?.classList.remove('hidden');
    renderArtifacts();

    addToast('New chat started', 'success');
  } catch (e) {
    console.error('clear', e);
    addToast('Failed to start new chat', 'error');
  }
};

/* ========== 23. Suggestions ========== */
window.useSuggestion = function (el) {
  if (!el) return;
  const txt = el.textContent
    .trim()
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[^\w\s\?]/g, '')
    .trim();
  if (userInput) userInput.value = txt;
  if (userInput) {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    userInput.focus();
  }
};

/* ========== 24. Welcome ========== */
function hideWelcome() {
  if (!conversationStarted) {
    welcomeScreen?.classList.add('hidden');
    conversationStarted = true;
  }
}

/* ========== 25. System Status ========== */
window.showSystemStatus = async function() {
  if (!currentSessionId) {
    addToast('No active session', 'error');
    return;
  }

  try {
    const response = await fetch(`/api/status?session_id=${encodeURIComponent(currentSessionId)}`);
    if (!response.ok) throw new Error('Failed to fetch status');

    const status = await response.json();
    
    const statusMsg = `
📊 System Status:
• Messages: ${status.messageCount || 0}
• Artifacts: ${status.artifactCount || 0}
• Admin Turns: ${status.metrics?.adminTurns || 0}
• Worker Turns: ${status.metrics?.workerTurns || 0}
• Total Delegations: ${status.metrics?.totalDelegations || 0}

🔧 Registered Tools: ${status.tools?.registered?.length || 0}
${status.tools?.registered ? status.tools.registered.map(t => `  • ${t}`).join('\n') : ''}

${status.memory ? `
🧠 Memory:
  • Cache Hit Rate: ${(status.memory.cacheHitRate * 100).toFixed(1)}%
  • Cache Size: ${status.memory.cacheSize}
` : ''}
    `.trim();

    // Create status modal
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-[#1e1e1e] rounded-xl max-w-2xl w-full p-6 border border-gray-700">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-white">System Status</h3>
          <button onclick="this.closest('.fixed').remove()" class="p-2 hover:bg-gray-700 rounded-lg">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <pre class="text-xs text-gray-300 bg-black/30 p-4 rounded-lg overflow-auto custom-scrollbar max-h-96">${escapeHtml(statusMsg)}</pre>
        <div class="mt-4 flex justify-end">
          <button onclick="this.closest('.fixed').remove()" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors text-sm">
            Close
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  } catch (e) {
    console.error('Failed to fetch status:', e);
    addToast('Failed to fetch system status', 'error');
  }
};
