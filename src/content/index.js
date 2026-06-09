// ── 消息类型常量 ──────────────────────────────────────────
const MSG = {
  GET_SELECTION: 'GET_SELECTION',
  TRANSLATE_START: 'TRANSLATE_START',
  STREAM_CHUNK: 'STREAM_CHUNK',
  TRANSLATE_DONE: 'TRANSLATE_DONE',
  TRANSLATE_ERROR: 'TRANSLATE_ERROR',
  SEND_TO_CHAT: 'SEND_TO_CHAT',
  CHAT_SEND: 'CHAT_SEND',
  CHAT_CHUNK: 'CHAT_CHUNK',
  CHAT_DONE: 'CHAT_DONE',
  CHAT_ERROR: 'CHAT_ERROR',
  SWITCH_PROVIDER: 'SWITCH_PROVIDER',
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
const SIDEBAR_WIDTH_MIN = 80;

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

(function () {
  const blockMath = {
    name: 'blockMath',
    level: 'block',
    start(src) { return src.indexOf('$$'); },
    tokenizer(src) {
      const m = src.match(/^\$\$([\s\S]+?)\$\$/);
      if (m) return { type: 'blockMath', raw: m[0], math: m[1].trim() };
    },
    renderer(t) {
      try { return '<p>' + katex.renderToString(t.math, { displayMode: true, throwOnError: false }) + '</p>'; }
      catch { return `<p>$$${t.math}$$</p>`; }
    },
  };
  const inlineMath = {
    name: 'inlineMath',
    level: 'inline',
    start(src) { return src.indexOf('$'); },
    tokenizer(src) {
      const m = src.match(/^\$([^$\n]+?)\$/);
      if (m && m[1].trim()) return { type: 'inlineMath', raw: m[0], math: m[1] };
    },
    renderer(t) {
      try { return katex.renderToString(t.math, { throwOnError: false }); }
      catch { return `$${t.math}$`; }
    },
  };
  marked.use({ extensions: [blockMath, inlineMath] });
  marked.use({
    gfm: true,
    breaks: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
  });
})();

function renderMarkdown(raw) {
  const src = (raw || '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`);
  return marked.parse(src);
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
    this._cursorEl = null;
    this._streamTextNode = null;
    this._fontSize = 14;
    this._sidebarEl = null;
    this._saveQueue = null;
    this._modelSelect = null;
  }

  _build() {
    this._host = document.createElement('div');
    this._shadow = this._host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SIDEBAR_CSS_URL;
    this._shadow.appendChild(link);

    const hlCss = document.createElement('link');
    hlCss.rel = 'stylesheet';
    hlCss.href = chrome.runtime.getURL('src/libs/hljs-github.min.css');
    this._shadow.appendChild(hlCss);

    const katexCss = document.createElement('link');
    katexCss.rel = 'stylesheet';
    katexCss.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css';
    this._shadow.appendChild(katexCss);

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

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-clear';
    exportBtn.textContent = '导出 MD';
    exportBtn.addEventListener('click', () => this._exportMD());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(roleInput);
    header.appendChild(closeBtn);

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

    const inputRow = document.createElement('div');
    inputRow.className = 'input-row';
    inputRow.appendChild(this._inputEl);
    inputRow.appendChild(this._sendBtn);
    footer.appendChild(inputRow);

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    toolbar.appendChild(clearBtn);
    toolbar.appendChild(exportBtn);

    const modelLabel = document.createElement('span');
    modelLabel.className = 'model-label';
    modelLabel.textContent = '模型';

    this._modelSelect = document.createElement('select');
    this._modelSelect.className = 'model-select';
    this._modelSelect.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: MSG.SWITCH_PROVIDER, payload: { id: this._modelSelect.value } });
    });

    toolbar.appendChild(modelLabel);
    toolbar.appendChild(this._modelSelect);
    footer.appendChild(toolbar);

    sidebar.appendChild(header);
    sidebar.appendChild(this._messagesEl);
    sidebar.appendChild(footer);

    this._shadow.appendChild(handle);
    this._shadow.appendChild(sidebar);

    this._sidebarEl = sidebar;

    this._loadProviders();
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.providers || changes.activeProviderId) this._loadProviders();
    });

    this._host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this._fontSize += e.deltaY < 0 ? 1 : -1;
      this._fontSize = Math.min(Math.max(this._fontSize, 10), 28);
      this._sidebarEl.style.fontSize = this._fontSize + 'px';
    }, { passive: false });
    this._applyWidth();
    document.body.appendChild(this._host);

    this._loadHistory();
  }

  async _loadProviders() {
    if (!this._modelSelect) return;
    const r = await chrome.storage.local.get(['providers', 'activeProviderId']);
    const list = r.providers || [];
    this._modelSelect.innerHTML = '';
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === r.activeProviderId) opt.selected = true;
      this._modelSelect.appendChild(opt);
    }
  }

  show() {
    if (!this._host) this._build();
    document.body.style.transition = 'margin-right 0.3s ease';
    this._host.style.display = 'flex';
    document.body.style.marginRight = this._width + 'px';
    if (this._fab) this._fab.textContent = '✕';
  }

  hide() {
    if (this._host) this._host.style.display = 'none';
    document.body.style.transition = 'margin-right 0.3s ease';
    document.body.style.marginRight = '0';
    setTimeout(() => { document.body.style.transition = ''; }, 300);
    if (this._fab) this._fab.textContent = '💬';
  }

  toggle() {
    if (!this._host || this._host.style.display === 'none') {
      this.show();
    } else {
      this.hide();
    }
  }

  buildFab() {
    this._fab = document.createElement('button');
    this._fab.textContent = '💬';
    this._fab.style.cssText = `
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2147483646;
      width: 36px;
      height: 36px;
      border-radius: 8px 0 0 8px;
      border: none;
      background: #6366f1;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      box-shadow: -2px 0 8px rgba(0,0,0,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
    `;
    this._fab.addEventListener('click', () => this.toggle());
    this._makeFabDraggable(this._fab);
    document.body.appendChild(this._fab);
  }

  _makeFabDraggable(btn) {
    let dragged = false;
    let startY, startTop;
    btn.addEventListener('mousedown', (e) => {
      dragged = false;
      startY = e.clientY;
      startTop = btn.getBoundingClientRect().top;
      const onMove = (e) => {
        const dy = Math.abs(e.clientY - startY);
        if (dy > 4) dragged = true;
        const newTop = Math.min(Math.max(startTop + e.clientY - startY, 0), window.innerHeight - 36);
        btn.style.top = newTop + 'px';
        btn.style.transform = 'none';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragged) e.stopImmediatePropagation();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    btn.addEventListener('click', (e) => {
      if (dragged) e.stopImmediatePropagation();
    });
  }

  sendTranslation(originalText, translatedText) {
    this.show();
    const content = `【原文】${originalText}\n【译文】${translatedText}`;
    this._appendBubble('user', content);
    this._saveQueue = (this._saveQueue || Promise.resolve()).then(async () => {
      const r = await chrome.storage.local.get('chatHistory');
      const history = r.chatHistory || [];
      history.push({ role: 'user', content });
      await chrome.storage.local.set({ chatHistory: history });
    });
    this._scrollToBottom();
  }

  appendChunk(chunk) {
    if (!this._currentBubble) {
      this._rawText = '';
      this._currentBubble = this._appendBubble('assistant', '');
      this._streamTextNode = document.createTextNode('');
      this._cursorEl = document.createElement('span');
      this._cursorEl.className = 'cursor';
      this._currentBubble.appendChild(this._streamTextNode);
      this._currentBubble.appendChild(this._cursorEl);
    }
    this._rawText += chunk;
    this._streamTextNode.textContent = this._rawText;
    this._scrollToBottom();
  }

  streamDone() {
    if (this._currentBubble) {
      if (this._cursorEl) { this._cursorEl.remove(); this._cursorEl = null; }
      this._streamTextNode = null;
      const split = this._splitDoc(this._rawText || '');
      if (split) {
        this._currentBubble.innerHTML = renderMarkdown(split.preamble);
        this._appendDocBubble(split.doc);
      } else {
        this._currentBubble.innerHTML = renderMarkdown(this._rawText || '');
      }
      this._currentBubble = null;
      this._rawText = '';
    }
    this._streaming = false;
    if (this._sendBtn) this._sendBtn.disabled = false;
    this._scrollToBottom();
  }

  _splitDoc(rawText) {
    if (rawText.length < 150) return null;
    const lines = rawText.split('\n');
    let splitIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^#{1,3}\s/.test(t) || /^\|.+\|/.test(t)) {
        splitIdx = i;
        break;
      }
    }
    if (splitIdx <= 0) return null;
    const preamble = lines.slice(0, splitIdx).join('\n').trim();
    if (!preamble) return null;
    const doc = lines.slice(splitIdx).join('\n').trim();
    if (!doc) return null;
    return { preamble, doc };
  }

  _appendDocBubble(text) {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';

    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(text);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-export';
    exportBtn.title = '导出为 MD 文件';
    exportBtn.textContent = '导出';
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `doc-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });

    bubble.appendChild(exportBtn);
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    this._messagesEl.appendChild(row);
    return bubble;
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

  _exportMD() {
    chrome.storage.local.get('chatHistory').then(r => {
      const history = r.chatHistory || [];
      if (history.length === 0) return;
      const lines = [];
      for (const msg of history) {
        if (msg.role === 'user') {
          lines.push(`**用户：**\n\n${msg.content}\n`);
        } else if (msg.role === 'assistant') {
          lines.push(`**助手：**\n\n${msg.content}\n`);
        }
        lines.push('---\n');
      }
      const md = lines.join('\n');
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${new Date().toISOString().slice(0,10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  _loadHistory() {
    chrome.storage.local.get('chatHistory').then(r => {
      const history = r.chatHistory || [];
      for (const msg of history) {
        if (msg.role === 'user') {
          this._appendBubble('user', msg.content);
        } else if (msg.role === 'assistant') {
          const split = this._splitDoc(msg.content);
          if (split) {
            this._appendBubble('assistant', split.preamble);
            this._appendDocBubble(split.doc);
          } else {
            this._appendBubble('assistant', msg.content);
          }
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
    if (role === 'assistant') {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }
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
      document.body.style.transition = 'none';
      const startX = e.clientX;
      const startWidth = this._width;

      const onMove = (e) => {
        const delta = startX - e.clientX;
        this._width = Math.min(Math.max(startWidth + delta, SIDEBAR_WIDTH_MIN), window.innerWidth - 20);
        this._applyWidth();
        document.body.style.marginRight = this._width + 'px';
        panel._nudgeFromSidebar(this._width);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.transition = '';
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
    this._panel = null;
    this._state = 'normal'; // 'normal' | 'minimized' | 'maximized'
    this._savedRect = null;
    this._minimizeBtn = null;
    this._maximizeBtn = null;
    this._fabEl = null;
    this._text = '';
    this._original = '';
    this._rafPending = false;
    this._pendingChunks = [];
    this._fontSize = 14;
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

    const controls = document.createElement('div');
    controls.className = 'panel-controls';

    this._minimizeBtn = document.createElement('button');
    this._minimizeBtn.className = 'panel-btn';
    this._minimizeBtn.textContent = '─';
    this._minimizeBtn.title = '最小化';
    this._minimizeBtn.addEventListener('click', () => this._toggleMinimize());

    this._maximizeBtn = document.createElement('button');
    this._maximizeBtn.className = 'panel-btn';
    this._maximizeBtn.textContent = '□';
    this._maximizeBtn.title = '最大化';
    this._maximizeBtn.addEventListener('click', () => this._toggleMaximize());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-btn panel-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', () => this.destroy());

    controls.appendChild(this._minimizeBtn);
    controls.appendChild(this._maximizeBtn);
    controls.appendChild(closeBtn);
    header.appendChild(label);
    header.appendChild(controls);

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

    this._panel = panel;
    this._state = 'normal';
    this._makeResizableEdges(panel);
    this._host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this._fontSize += e.deltaY < 0 ? 1 : -1;
      this._fontSize = Math.min(Math.max(this._fontSize, 10), 28);
      panel.style.fontSize = this._fontSize + 'px';
    }, { passive: false });
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
    if (this._fabEl) { this._fabEl.remove(); this._fabEl = null; }
    if (this._host) {
      this._host.remove();
      this._host = null;
      this._shadow = null;
      this._contentEl = null;
      this._footerEl = null;
      this._panel = null;
      this._state = 'normal';
      this._savedRect = null;
      this._minimizeBtn = null;
      this._maximizeBtn = null;
      this._text = '';
      this._original = '';
      this._pendingChunks = [];
      this._rafPending = false;
    }
  }

  _makeDraggable(handle, panel) {
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      if (this._state === 'maximized') return;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(panel.style.left) || 0;
      startTop = parseInt(panel.style.top) || 0;

      const onMove = (e) => {
        const sidebarW = sidebar._host && sidebar._host.style.display !== 'none' ? sidebar._width : 0;
        const maxLeft = window.innerWidth - sidebarW - panel.offsetWidth - 4;
        panel.style.left = `${Math.min(Math.max(startLeft + e.clientX - startX, 4), maxLeft)}px`;
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
    const sidebarW = sidebar._host && sidebar._host.style.display !== 'none' ? sidebar._width : 0;
    return Math.min(Math.max(x, 8), window.innerWidth - 340 - sidebarW);
  }

  _clampY(y) {
    return Math.min(Math.max(y, 8), window.innerHeight - 200);
  }

  _saveNormalRect() {
    this._savedRect = {
      left: this._panel.style.left,
      top: this._panel.style.top,
      width: this._panel.style.width,
      height: this._panel.style.height,
      maxHeight: this._panel.style.maxHeight,
      maxWidth: this._panel.style.maxWidth,
    };
  }

  _restoreNormal() {
    const r = this._savedRect;
    if (r) {
      this._panel.style.left = r.left;
      this._panel.style.top = r.top;
      this._panel.style.width = r.width;
      this._panel.style.height = r.height;
      this._panel.style.maxHeight = r.maxHeight;
      this._panel.style.maxWidth = r.maxWidth || '';
    }
    this._panel.style.display = '';
    this._panel.style.borderRadius = '';
    this._contentEl.style.display = '';
    if (this._footerEl.children.length > 0) this._footerEl.style.display = 'flex';
    this._state = 'normal';
    if (this._minimizeBtn) { this._minimizeBtn.textContent = '─'; this._minimizeBtn.title = '最小化'; }
    if (this._maximizeBtn) { this._maximizeBtn.textContent = '□'; this._maximizeBtn.title = '最大化'; }
  }

  _toggleMinimize() {
    if (!this._panel) return;
    if (this._state === 'minimized') {
      if (this._fabEl) { this._fabEl.remove(); this._fabEl = null; }
      this._restoreNormal();
      return;
    }
    let ballLeft, ballTop;
    if (this._state === 'normal') {
      this._saveNormalRect();
      ballLeft = parseInt(this._panel.style.left) || 100;
      ballTop = parseInt(this._panel.style.top) || 100;
    } else {
      // 从最大化收起，用 savedRect 中的位置放悬浮球
      ballLeft = parseInt((this._savedRect && this._savedRect.left) || '100') || 100;
      ballTop = parseInt((this._savedRect && this._savedRect.top) || '100') || 100;
      if (this._maximizeBtn) { this._maximizeBtn.textContent = '□'; this._maximizeBtn.title = '最大化'; }
    }
    this._panel.style.display = 'none';
    this._state = 'minimized';

    const fab = document.createElement('button');
    fab.textContent = '译';
    fab.style.cssText = `
      position: fixed;
      left: ${Math.min(Math.max(ballLeft, 0), window.innerWidth - 44)}px;
      top: ${Math.min(Math.max(ballTop, 0), window.innerHeight - 44)}px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: none;
      background: rgba(102,126,234,0.92);
      color: #fff;
      font-size: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
    `;
    let fabDragged = false;
    fab.addEventListener('mousedown', (e) => {
      fabDragged = false;
      const startX = e.clientX, startY = e.clientY;
      let startLeft = parseInt(fab.style.left) || 0;
      let startTop = parseInt(fab.style.top) || 0;
      const onMove = (mv) => {
        if (Math.abs(mv.clientX - startX) > 4 || Math.abs(mv.clientY - startY) > 4) fabDragged = true;
        fab.style.left = Math.min(Math.max(startLeft + mv.clientX - startX, 0), window.innerWidth - 44) + 'px';
        fab.style.top = Math.min(Math.max(startTop + mv.clientY - startY, 0), window.innerHeight - 44) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    fab.addEventListener('click', () => {
      if (fabDragged) return;
      fab.remove();
      this._fabEl = null;
      this._restoreNormal();
    });
    this._fabEl = fab;
    this._shadow.appendChild(fab);
  }

  _toggleMaximize() {
    if (!this._panel) return;
    if (this._state === 'maximized') {
      this._restoreNormal();
      return;
    }
    if (this._state === 'normal') {
      this._saveNormalRect();
    } else {
      // 从最小化放大：先恢复内容可见性
      this._contentEl.style.display = '';
      if (this._footerEl.children.length > 0) this._footerEl.style.display = 'flex';
      if (this._minimizeBtn) { this._minimizeBtn.textContent = '─'; this._minimizeBtn.title = '最小化'; }
    }
    this._panel.style.left = '0';
    this._panel.style.top = '0';
    this._panel.style.width = '100vw';
    this._panel.style.maxWidth = 'none';
    this._panel.style.height = '100vh';
    this._panel.style.maxHeight = 'none';
    this._panel.style.borderRadius = '0';
    this._state = 'maximized';
    if (this._maximizeBtn) { this._maximizeBtn.textContent = '❐'; this._maximizeBtn.title = '还原'; }
  }

  _nudgeFromSidebar(sidebarWidth) {
    if (!this._panel) return;
    const boundary = window.innerWidth - sidebarWidth - 8;
    const panelRight = parseInt(this._panel.style.left) + this._panel.offsetWidth;
    if (panelRight > boundary) {
      this._panel.style.left = Math.max(boundary - this._panel.offsetWidth, 8) + 'px';
    }
  }

  _makeResizableEdges(panel) {
    const edges = [
      ['n',  'top:0;left:6px;right:6px;height:5px'],
      ['s',  'bottom:0;left:6px;right:6px;height:5px'],
      ['e',  'right:0;top:6px;bottom:6px;width:5px'],
      ['w',  'left:0;top:6px;bottom:6px;width:5px'],
      ['ne', 'top:0;right:0;width:8px;height:8px'],
      ['nw', 'top:0;left:0;width:8px;height:8px'],
      ['se', 'bottom:0;right:0;width:8px;height:8px'],
      ['sw', 'bottom:0;left:0;width:8px;height:8px'],
    ];
    for (const [dir, pos] of edges) {
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;z-index:10;${pos};cursor:${dir}-resize`;
      el.addEventListener('mousedown', (e) => {
        if (this._state === 'maximized') return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const startL = parseInt(panel.style.left) || 0;
        const startT = parseInt(panel.style.top) || 0;
        const startW = panel.offsetWidth;
        const startH = panel.offsetHeight;
        const MIN_W = 80, MIN_H = 40;
        const onMove = (mv) => {
          panel.style.maxHeight = 'none';
          const dx = mv.clientX - startX, dy = mv.clientY - startY;
          let w = startW, h = startH, l = startL, t = startT;
          if (dir.includes('e')) {
            const sidebarW = sidebar._host && sidebar._host.style.display !== 'none' ? sidebar._width : 0;
            w = Math.min(Math.max(startW + dx, MIN_W), window.innerWidth - sidebarW - l - 8);
          }
          if (dir.includes('s')) h = Math.max(startH + dy, MIN_H);
          if (dir.includes('w')) { w = Math.max(startW - dx, MIN_W); l = startL + startW - w; }
          if (dir.includes('n')) { h = Math.max(startH - dy, MIN_H); t = startT + startH - h; }
          panel.style.width = w + 'px';
          panel.style.height = h + 'px';
          panel.style.left = l + 'px';
          panel.style.top = t + 'px';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      panel.appendChild(el);
    }
  }
}

// ── 实例化 ────────────────────────────────────────────────
const panel = new FloatingPanel();
const sidebar = new ChatSidebar();
sidebar.buildFab();

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
