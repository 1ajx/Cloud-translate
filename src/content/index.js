// ── 消息类型常量 ──────────────────────────────────────────
const MSG = {
  GET_SELECTION: 'GET_SELECTION',
  TRANSLATE_START: 'TRANSLATE_START',
  STREAM_CHUNK: 'STREAM_CHUNK',
  TRANSLATE_DONE: 'TRANSLATE_DONE',
  TRANSLATE_ERROR: 'TRANSLATE_ERROR',
  CHAT_SEND: 'CHAT_SEND',
  CHAT_CHUNK: 'CHAT_CHUNK',
  CHAT_DONE: 'CHAT_DONE',
  CHAT_ERROR: 'CHAT_ERROR',
};

const SIDEBAR_CSS_URL = chrome.runtime.getURL('src/content/sidebar.css');

// ── 选区捕获 ──────────────────────────────────────────────
function getSelectedText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  return {
    text: sel.toString().trim(),
    position: {
      x: rect.left,
      y: rect.bottom + 8,
    },
  };
}

// ── 聊天侧边栏 ────────────────────────────────────────────
const SIDEBAR_WIDTH_DEFAULT = 380;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 600;

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

class ChatSidebar {
  constructor() {
    this._host = null;
    this._shadow = null;
    this._messagesEl = null;
    this._inputEl = null;
    this._sendBtn = null;
    this._width = SIDEBAR_WIDTH_DEFAULT;
    this._streaming = false;
    this._currentBubble = null;
  }

  _build() {
    console.log('[译插件] 开始构建侧边栏 DOM');
    this._host = document.createElement('div');
    this._shadow = this._host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SIDEBAR_CSS_URL;
    this._shadow.appendChild(link);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    this._makeResizable(handle);

    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const roleInput = document.createElement('input');
    roleInput.className = 'role-input';
    roleInput.type = 'text';
    roleInput.placeholder = '角色/翻译背景（如：你是测绘专业的人）';
    chrome.storage.local.get('rolePrompt').then(r => { roleInput.value = r.rolePrompt || ''; });
    roleInput.addEventListener('input', debounce(() => {
      chrome.storage.local.set({ rolePrompt: roleInput.value });
    }, 500));

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-clear';
    clearBtn.textContent = '清空对话';
    clearBtn.addEventListener('click', () => this._clearHistory());

    header.appendChild(roleInput);
    header.appendChild(clearBtn);

    this._messagesEl = document.createElement('div');
    this._messagesEl.className = 'messages';

    const footer = document.createElement('div');
    footer.className = 'sidebar-footer';

    this._inputEl = document.createElement('textarea');
    this._inputEl.className = 'chat-input';
    this._inputEl.placeholder = '输入消息，Enter 发送，Shift+Enter 换行';
    this._inputEl.rows = 1;
    this._inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
    this._inputEl.addEventListener('input', () => {
      this._inputEl.style.height = 'auto';
      this._inputEl.style.height = Math.min(this._inputEl.scrollHeight, 120) + 'px';
    });

    this._sendBtn = document.createElement('button');
    this._sendBtn.className = 'btn-send';
    this._sendBtn.textContent = '发送';
    this._sendBtn.addEventListener('click', () => this._send());

    footer.appendChild(this._inputEl);
    footer.appendChild(this._sendBtn);

    sidebar.appendChild(header);
    sidebar.appendChild(this._messagesEl);
    sidebar.appendChild(footer);

    this._shadow.appendChild(handle);
    this._shadow.appendChild(sidebar);

    this._applyWidth();
    document.body.appendChild(this._host);
    document.body.style.marginRight = this._width + 'px';

    this._loadHistory();
  }

  show() {
    if (!this._host) this._build();
    this._host.style.display = 'flex';
    document.body.style.marginRight = this._width + 'px';
  }

  sendTranslation(originalText, translatedText) {
    this.show();
    const content = `【原文】${originalText}\n【译文】${translatedText}`;
    this._appendBubble('user', content);
    chrome.storage.local.get('chatHistory').then(r => {
      const history = r.chatHistory || [];
      history.push({ role: 'user', content });
      chrome.storage.local.set({ chatHistory: history });
    });
    this._scrollToBottom();
  }

  appendChunk(chunk) {
    if (!this._currentBubble) {
      this._currentBubble = this._appendBubble('assistant', '');
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this._currentBubble.appendChild(cursor);
    }
    const cursor = this._currentBubble.querySelector('.cursor');
    const textNode = document.createTextNode(chunk);
    this._currentBubble.insertBefore(textNode, cursor);
    this._scrollToBottom();
  }

  streamDone() {
    if (this._currentBubble) {
      const cursor = this._currentBubble.querySelector('.cursor');
      if (cursor) cursor.remove();
      this._currentBubble = null;
    }
    this._streaming = false;
    if (this._sendBtn) this._sendBtn.disabled = false;
    this._scrollToBottom();
  }

  showError(message) {
    this.streamDone();
    if (!this._messagesEl) return;
    const err = document.createElement('div');
    err.className = 'error-bubble';
    err.textContent = `⚠ ${message}`;
    this._messagesEl.appendChild(err);
    this._scrollToBottom();
  }

  _send() {
    if (this._streaming) return;
    if (!this._inputEl) return;
    const content = this._inputEl.value.trim();
    if (!content) return;

    this._inputEl.value = '';
    this._inputEl.style.height = 'auto';
    this._streaming = true;
    this._sendBtn.disabled = true;
    this._currentBubble = null;

    this._appendBubble('user', content);
    this._scrollToBottom();

    chrome.runtime.sendMessage({ type: MSG.CHAT_SEND, payload: { content } });
  }

  _clearHistory() {
    chrome.storage.local.set({ chatHistory: [] });
    if (this._messagesEl) this._messagesEl.innerHTML = '';
    this._streaming = false;
    if (this._sendBtn) this._sendBtn.disabled = false;
    this._currentBubble = null;
  }

  _loadHistory() {
    chrome.storage.local.get('chatHistory').then(r => {
      const history = r.chatHistory || [];
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          this._appendBubble(msg.role, msg.content);
        }
      }
      this._scrollToBottom();
    });
  }

  _appendBubble(role, text) {
    const row = document.createElement('div');
    row.className = `msg-row ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    this._messagesEl.appendChild(row);
    return bubble;
  }

  _scrollToBottom() {
    if (this._messagesEl) {
      this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
    }
  }

  _applyWidth() {
    this._host.style.cssText = `
      position: fixed;
      top: 0;
      right: 0;
      height: 100vh;
      width: ${this._width}px;
      z-index: 2147483647;
      display: flex;
    `;
  }

  _makeResizable(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = this._width;

      const onMove = (e) => {
        const delta = startX - e.clientX;
        this._width = Math.min(Math.max(startWidth + delta, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);
        this._applyWidth();
        document.body.style.marginRight = this._width + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

// ── 浮窗控制器 ────────────────────────────────────────────
const CSS_URL = chrome.runtime.getURL('src/content/content.css');

class FloatingPanel {
  constructor() {
    this._host = null;
    this._shadow = null;
    this._contentEl = null;
    this._footerEl = null;
    this._text = '';
    this._original = '';
    this._rafPending = false;
    this._pendingChunks = [];
  }

  show(position, originalText) {
    this.destroy();
    this._original = originalText || '';

    this._host = document.createElement('div');
    this._shadow = this._host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    this._shadow.appendChild(link);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.left = `${this._clampX(position.x)}px`;
    panel.style.top = `${this._clampY(position.y)}px`;

    const header = document.createElement('div');
    header.className = 'panel-header';

    const label = document.createElement('span');
    label.className = 'panel-label';
    label.textContent = '翻译结果';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.destroy());

    header.appendChild(label);
    header.appendChild(closeBtn);

    this._contentEl = document.createElement('div');
    this._contentEl.className = 'panel-content loading';
    this._contentEl.textContent = '翻译中…';

    this._footerEl = document.createElement('div');
    this._footerEl.className = 'panel-footer';
    this._footerEl.style.display = 'none';

    panel.appendChild(header);
    panel.appendChild(this._contentEl);
    panel.appendChild(this._footerEl);
    this._shadow.appendChild(panel);

    document.body.appendChild(this._host);
    this._makeDraggable(header, panel);
  }

  appendChunk(chunk) {
    if (!this._contentEl) return;

    if (this._text === '') {
      this._contentEl.classList.remove('loading');
      this._contentEl.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this._contentEl.appendChild(cursor);
    }

    this._pendingChunks.push(chunk);
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => this._flushChunks());
    }
  }

  _flushChunks() {
    this._rafPending = false;
    if (!this._contentEl) return;

    const cursor = this._contentEl.querySelector('.cursor');
    for (const chunk of this._pendingChunks) {
      this._text += chunk;
      const textNode = document.createTextNode(chunk);
      this._contentEl.insertBefore(textNode, cursor);
    }
    this._pendingChunks = [];
  }

  done() {
    if (!this._contentEl) return;
    this._flushChunks();

    const cursor = this._contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();

    this._footerEl.style.display = 'flex';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this._text).then(() => {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => (copyBtn.textContent = '复制'), 1500);
      });
    });
    this._footerEl.appendChild(copyBtn);

    const chatBtn = document.createElement('button');
    chatBtn.className = 'btn-copy';
    chatBtn.textContent = '送入聊天';
    chatBtn.addEventListener('click', () => {
      console.log('[译插件] 送入聊天按钮被点击，准备发送消息');
      chrome.runtime.sendMessage({
        type: MSG.SEND_TO_CHAT,
        payload: { original: this._original, translated: this._text },
      });
      this.destroy();
    });
    this._footerEl.appendChild(chatBtn);
  }

  showError(message) {
    if (!this._contentEl) return;
    const cursor = this._contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    this._contentEl.classList.remove('loading');
    this._contentEl.innerHTML = '';
    const err = document.createElement('span');
    err.className = 'error-text';
    err.textContent = `⚠ ${message}`;
    this._contentEl.appendChild(err);
  }

  destroy() {
    if (this._host) {
      this._host.remove();
      this._host = null;
      this._shadow = null;
      this._contentEl = null;
      this._footerEl = null;
      this._text = '';
      this._original = '';
      this._pendingChunks = [];
      this._rafPending = false;
    }
  }

  _makeDraggable(handle, panel) {
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(panel.style.left) || 0;
      startTop = parseInt(panel.style.top) || 0;

      const onMove = (e) => {
        panel.style.left = `${startLeft + e.clientX - startX}px`;
        panel.style.top = `${startTop + e.clientY - startY}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _clampX(x) {
    return Math.min(Math.max(x, 8), window.innerWidth - 380);
  }

  _clampY(y) {
    return Math.min(Math.max(y, 8), window.innerHeight - 200);
  }
}

// ── 实例化 ────────────────────────────────────────────────
const panel = new FloatingPanel();
const sidebar = new ChatSidebar();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MSG.GET_SELECTION: {
      const result = getSelectedText();
      sendResponse(result);
      break;
    }
    case MSG.TRANSLATE_START: {
      panel.show(message.payload.position, message.payload.originalText);
      break;
    }
    case MSG.STREAM_CHUNK: {
      panel.appendChunk(message.payload.chunk);
      break;
    }
    case MSG.TRANSLATE_DONE: {
      panel.done();
      break;
    }
    case MSG.TRANSLATE_ERROR: {
      panel.showError(message.payload.message);
      break;
    }
    case MSG.SEND_TO_CHAT: {
      console.log('[译插件] content script 收到 SEND_TO_CHAT，开始展开侧边栏');
      sidebar.sendTranslation(message.payload.original, message.payload.translated);
      break;
    }
    case MSG.CHAT_CHUNK: {
      sidebar.appendChunk(message.payload.chunk);
      break;
    }
    case MSG.CHAT_DONE: {
      sidebar.streamDone();
      break;
    }
    case MSG.CHAT_ERROR: {
      sidebar.showError(message.payload.message);
      break;
    }
  }
  return false;
});
