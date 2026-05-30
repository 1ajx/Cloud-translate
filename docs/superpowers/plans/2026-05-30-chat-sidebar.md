# Chat Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有划词翻译插件中新增右侧聊天侧边栏，支持角色/背景设定、送入聊天、多轮对话。

**Architecture:** content script 自包含脚本中新增 `ChatSidebar` 类（Shadow DOM 注入页面右侧），background 新增 `chat()` API 和存储函数，消息类型扩展区分翻译流和聊天流。

**Tech Stack:** JavaScript ES2020+, Chrome Extension MV3, chrome.storage.local, Fetch API + SSE

---

## 文件清单

| 文件 | 变动 |
|------|------|
| `src/shared/constants.js` | 新增 `MSG.CHAT_SEND/CHAT_CHUNK/CHAT_DONE/CHAT_ERROR`，`STORAGE_KEY.ROLE_PROMPT/CHAT_HISTORY` |
| `src/background/config-store.js` | 新增 `getRolePrompt`, `saveRolePrompt`, `getChatHistory`, `saveChatHistory` |
| `src/background/api-client.js` | 新增 `chat()` 函数；`translate()` 新增 `rolePrompt` 参数 |
| `src/background/index.js` | 新增 `CHAT_SEND` 路由；`translate-selection` 命令读取 `rolePrompt` |
| `src/content/index.js` | 新增 `ChatSidebar` 类、`MSG` 常量补全、浮窗「送入聊天」按钮、消息路由扩展 |
| `src/content/sidebar.css` | 新增，侧边栏 Shadow DOM 样式 |
| `manifest.json` | `web_accessible_resources` 新增 `sidebar.css` |

---

## Task 1: 扩展常量与存储层

**Files:**
- Modify: `src/shared/constants.js`
- Modify: `src/background/config-store.js`

- [ ] **Step 1: 在 constants.js 新增消息类型和存储键**

将 `src/shared/constants.js` 改为：

```js
export const MSG = {
  GET_SELECTION: 'GET_SELECTION',
  SELECTION_RESULT: 'SELECTION_RESULT',
  TRANSLATE_START: 'TRANSLATE_START',
  STREAM_CHUNK: 'STREAM_CHUNK',
  TRANSLATE_DONE: 'TRANSLATE_DONE',
  TRANSLATE_ERROR: 'TRANSLATE_ERROR',
  SWITCH_PROVIDER: 'SWITCH_PROVIDER',
  CHAT_SEND: 'CHAT_SEND',
  CHAT_CHUNK: 'CHAT_CHUNK',
  CHAT_DONE: 'CHAT_DONE',
  CHAT_ERROR: 'CHAT_ERROR',
};

export const DEFAULT_PROVIDER_TEMPLATE = {
  name: 'Deepseek V3',
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  format: 'openai',
  temperature: 0.3,
  maxTokens: 4096,
};

export const STORAGE_KEY = {
  PROVIDERS: 'providers',
  ACTIVE_ID: 'activeProviderId',
  ROLE_PROMPT: 'rolePrompt',
  CHAT_HISTORY: 'chatHistory',
};
```

- [ ] **Step 2: 在 config-store.js 新增角色和历史存储函数**

在 `src/background/config-store.js` 末尾追加：

```js
export async function getRolePrompt() {
  const result = await chrome.storage.local.get(STORAGE_KEY.ROLE_PROMPT);
  return result[STORAGE_KEY.ROLE_PROMPT] || '';
}

export async function saveRolePrompt(prompt) {
  await chrome.storage.local.set({ [STORAGE_KEY.ROLE_PROMPT]: prompt });
}

export async function getChatHistory() {
  const result = await chrome.storage.local.get(STORAGE_KEY.CHAT_HISTORY);
  return result[STORAGE_KEY.CHAT_HISTORY] || [];
}

export async function saveChatHistory(history) {
  await chrome.storage.local.set({ [STORAGE_KEY.CHAT_HISTORY]: history });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.js src/background/config-store.js
git commit -m "feat: add chat/role storage keys and config-store helpers"
```

---

## Task 2: 新增 chat() API 函数，扩展 translate() rolePrompt 参数

**Files:**
- Modify: `src/background/api-client.js`

- [ ] **Step 1: 修改 translate()，接收 rolePrompt 参数注入 system prompt**

将 `src/background/api-client.js` 中 `translate` 函数签名和 system message 改为：

```js
export async function translate(text, provider, rolePrompt, onChunk, onDone, onError) {
  const url = `${provider.baseURL}/chat/completions`;
  const baseInstruction = '将用户提供的文本翻译成中文，只输出译文，不加解释。如果原文已是中文，则翻译成英文。';
  const systemContent = rolePrompt
    ? `你是一名专业翻译。${rolePrompt}。${baseInstruction}`
    : `你是一名专业翻译。${baseInstruction}`;

  const body = {
    model: provider.model,
    stream: true,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: text },
    ],
  };
  // 以下 fetch 逻辑不变
```

- [ ] **Step 2: 在 api-client.js 末尾新增 chat() 函数**

```js
/**
 * 多轮聊天请求，支持 SSE 流式输出。
 * @param {Array} messages - OpenAI messages 数组（含历史）
 * @param {object} provider
 * @param {function} onChunk
 * @param {function} onDone
 * @param {function} onError
 */
export async function chat(messages, provider, onChunk, onDone, onError) {
  const url = `${provider.baseURL}/chat/completions`;
  const body = {
    model: provider.model,
    stream: true,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    messages,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    onError(`网络错误：${e.message}`);
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    onError(`API 错误 ${response.status}：${text.slice(0, 200)}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { onDone(); return; }
      try {
        const json = JSON.parse(data);
        const chunk = json.choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch { /* ignore malformed */ }
    }
  }
  onDone();
}
```

- [ ] **Step 3: Commit**

```bash
git add src/background/api-client.js
git commit -m "feat: add chat() API, add rolePrompt param to translate()"
```

---

## Task 3: 扩展 background/index.js 路由

**Files:**
- Modify: `src/background/index.js`

- [ ] **Step 1: 更新 import，translate 命令读取 rolePrompt，新增 CHAT_SEND 路由**

将 `src/background/index.js` 全文替换为：

```js
import { MSG } from '../shared/constants.js';
import { getActiveProvider, setActiveProviderId, getRolePrompt, getChatHistory, saveChatHistory } from './config-store.js';
import { translate, chat } from './api-client.js';

// 快捷键触发翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let selectionResult;
  try {
    selectionResult = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_SELECTION });
  } catch {
    return;
  }

  const { text, position } = selectionResult || {};
  if (!text?.trim()) return;

  chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_START, payload: { position } });

  const [provider, rolePrompt] = await Promise.all([getActiveProvider(), getRolePrompt()]);
  if (!provider) {
    chrome.tabs.sendMessage(tab.id, {
      type: MSG.TRANSLATE_ERROR,
      payload: { message: '未配置任何模型，请先前往选项页添加 Provider。' },
    });
    return;
  }

  await translate(
    text,
    provider,
    rolePrompt,
    (chunk) => chrome.tabs.sendMessage(tab.id, { type: MSG.STREAM_CHUNK, payload: { chunk } }),
    () => chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_DONE }),
    (message) => chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_ERROR, payload: { message } }),
  );
});

// 消息路由
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG.SWITCH_PROVIDER) {
    setActiveProviderId(message.payload.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === MSG.CHAT_SEND) {
    const tabId = sender.tab?.id;
    if (!tabId) return false;

    (async () => {
      const [provider, rolePrompt, history] = await Promise.all([
        getActiveProvider(),
        getRolePrompt(),
        getChatHistory(),
      ]);

      if (!provider) {
        chrome.tabs.sendMessage(tabId, {
          type: MSG.CHAT_ERROR,
          payload: { message: '未配置任何模型，请先前往选项页添加 Provider。' },
        });
        return;
      }

      // 构造 messages：system + 历史 + 本次用户消息
      const systemContent = rolePrompt
        ? `你是一名专业助手。${rolePrompt}。请根据用户的要求回答，用户让你翻译才翻译，否则正常对话。`
        : '你是一名专业助手。请根据用户的要求回答，用户让你翻译才翻译，否则正常对话。';

      const userMsg = { role: 'user', content: message.payload.content };
      const messages = [
        { role: 'system', content: systemContent },
        ...history,
        userMsg,
      ];

      // 先把用户消息存入历史
      const newHistory = [...history, userMsg];
      let assistantContent = '';

      await chat(
        messages,
        provider,
        (chunk) => {
          assistantContent += chunk;
          chrome.tabs.sendMessage(tabId, { type: MSG.CHAT_CHUNK, payload: { chunk } });
        },
        async () => {
          newHistory.push({ role: 'assistant', content: assistantContent });
          await saveChatHistory(newHistory);
          chrome.tabs.sendMessage(tabId, { type: MSG.CHAT_DONE });
        },
        (msg) => chrome.tabs.sendMessage(tabId, { type: MSG.CHAT_ERROR, payload: { message: msg } }),
      );
    })();

    return false;
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/background/index.js
git commit -m "feat: background routes CHAT_SEND, passes rolePrompt to translate"
```

---

## Task 4: 新增 sidebar.css，更新 manifest

**Files:**
- Create: `src/content/sidebar.css`
- Modify: `manifest.json`

- [ ] **Step 1: 创建 sidebar.css**

新建 `src/content/sidebar.css`：

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:host {
  all: initial;
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  z-index: 2147483647;
  display: flex;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
}

.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s;
  flex-shrink: 0;
}
.resize-handle:hover { background: rgba(99,102,241,0.4); }

.sidebar {
  width: 100%;
  height: 100%;
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-left: 1px solid rgba(0,0,0,0.12);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0,0,0,0.12);
}

.sidebar-header {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.role-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 6px;
  font-size: 13px;
  background: rgba(255,255,255,0.8);
  outline: none;
  color: #333;
}
.role-input:focus { border-color: #6366f1; }
.role-input::placeholder { color: #999; }

.btn-clear {
  padding: 5px 10px;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.btn-clear:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg-row {
  display: flex;
}
.msg-row.user { justify-content: flex-end; }
.msg-row.assistant { justify-content: flex-start; }

.bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.msg-row.user .bubble {
  background: #6366f1;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.msg-row.assistant .bubble {
  background: #f1f5f9;
  color: #1e293b;
  border-bottom-left-radius: 4px;
}

.bubble.loading { color: #94a3b8; font-style: italic; }

.cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s step-end infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.error-bubble {
  color: #dc2626;
  font-size: 12px;
  padding: 6px 10px;
  background: #fee2e2;
  border-radius: 8px;
  max-width: 80%;
}

.sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid rgba(0,0,0,0.08);
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 8px;
  font-size: 13px;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 120px;
  font-family: inherit;
  line-height: 1.4;
  background: rgba(255,255,255,0.9);
  color: #333;
}
.chat-input:focus { border-color: #6366f1; }

.btn-send {
  padding: 8px 14px;
  background: #6366f1;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
  height: 36px;
}
.btn-send:hover { background: #4f46e5; }
.btn-send:disabled { background: #a5b4fc; cursor: not-allowed; }
```

- [ ] **Step 2: 更新 manifest.json web_accessible_resources**

将 `manifest.json` 中 `web_accessible_resources` 改为：

```json
"web_accessible_resources": [{
  "resources": ["src/content/content.css", "src/content/sidebar.css"],
  "matches": ["<all_urls>"]
}]
```

- [ ] **Step 3: Commit**

```bash
git add src/content/sidebar.css manifest.json
git commit -m "feat: add sidebar.css and register as web accessible resource"
```

---

## Task 5: 在 content/index.js 新增 ChatSidebar 类

**Files:**
- Modify: `src/content/index.js`

- [ ] **Step 1: 补全文件顶部的 MSG 常量，新增 SIDEBAR_CSS_URL**

将 `src/content/index.js` 顶部的常量块替换为：

```js
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
```

- [ ] **Step 2: 在 FloatingPanel 类之前插入 ChatSidebar 类**

在 `// ── 浮窗控制器` 注释之前插入以下完整类：

```js
// ── 聊天侧边栏 ────────────────────────────────────────────
const SIDEBAR_WIDTH_DEFAULT = 380;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 600;
const DEBOUNCE_MS = 500;

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
    this._saveRole = debounce((v) => chrome.runtime.sendMessage({ type: 'SAVE_ROLE_PROMPT', payload: { value: v } }), DEBOUNCE_MS);
  }

  _build() {
    this._host = document.createElement('div');
    this._shadow = this._host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SIDEBAR_CSS_URL;
    this._shadow.appendChild(link);

    // 拖拽条
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    this._makeResizable(handle);

    // 主体
    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    // 顶部：角色输入 + 清空
    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const roleInput = document.createElement('input');
    roleInput.className = 'role-input';
    roleInput.type = 'text';
    roleInput.placeholder = '角色/翻译背景（如：你是测绘专业的人）';
    // 读取已保存的角色设定
    chrome.storage.local.get('rolePrompt').then(r => { roleInput.value = r.rolePrompt || ''; });
    roleInput.addEventListener('input', () => {
      chrome.storage.local.set({ rolePrompt: roleInput.value });
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-clear';
    clearBtn.textContent = '清空对话';
    clearBtn.addEventListener('click', () => this._clearHistory());

    header.appendChild(roleInput);
    header.appendChild(clearBtn);

    // 消息区
    this._messagesEl = document.createElement('div');
    this._messagesEl.className = 'messages';

    // 底部：输入框 + 发送
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

    // 加载已有历史
    this._loadHistory();
  }

  show() {
    if (!this._host) this._build();
    this._host.style.display = 'flex';
    document.body.style.marginRight = this._width + 'px';
  }

  hide() {
    if (this._host) this._host.style.display = 'none';
    document.body.style.marginRight = '0';
  }

  /** 把原文+译文作为用户消息送入聊天（不触发 AI 请求） */
  sendTranslation(originalText, translatedText) {
    this.show();
    const content = `【原文】${originalText}\n【译文】${translatedText}`;
    this._appendBubble('user', content);
    // 存入历史
    chrome.storage.local.get('chatHistory').then(r => {
      const history = r.chatHistory || [];
      history.push({ role: 'user', content });
      chrome.storage.local.set({ chatHistory: history });
    });
    this._scrollToBottom();
  }

  /** 收到 background 的流式 chunk */
  appendChunk(chunk) {
    if (!this._currentBubble) {
      this._currentBubble = this._appendBubble('assistant', '');
      this._currentBubble.classList.add('streaming');
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      this._currentBubble.appendChild(cursor);
    }
    const cursor = this._currentBubble.querySelector('.cursor');
    const textNode = document.createTextNode(chunk);
    this._currentBubble.insertBefore(textNode, cursor);
    this._scrollToBottom();
  }

  /** 流式完成 */
  streamDone() {
    if (this._currentBubble) {
      const cursor = this._currentBubble.querySelector('.cursor');
      if (cursor) cursor.remove();
      this._currentBubble.classList.remove('streaming');
      this._currentBubble = null;
    }
    this._streaming = false;
    this._sendBtn.disabled = false;
    this._scrollToBottom();
  }

  /** 显示错误 */
  showError(message) {
    this.streamDone();
    const err = document.createElement('div');
    err.className = 'error-bubble';
    err.textContent = `⚠ ${message}`;
    this._messagesEl.appendChild(err);
    this._scrollToBottom();
  }

  _send() {
    if (this._streaming) return;
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
    this._sendBtn.disabled = false;
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
```

- [ ] **Step 3: 修改 FloatingPanel.done()，新增「送入聊天」按钮**

找到 `done()` 方法中 `this._footerEl.appendChild(copyBtn);` 这行，在其后追加：

```js
    const chatBtn = document.createElement('button');
    chatBtn.className = 'btn-copy';
    chatBtn.textContent = '送入聊天';
    chatBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'SEND_TO_CHAT',
        payload: { original: this._original, translated: this._text },
      });
      this.destroy();
    });
    this._footerEl.appendChild(chatBtn);
```

同时在 `show(position)` 的参数里新增 `original` 字段存储：在 `show` 方法签名改为 `show(position, originalText)`，并在方法体内加：

```js
    this._original = originalText || '';
```

并在 `destroy()` 里加：

```js
      this._original = '';
```

- [ ] **Step 4: 修改消息监听，实例化 ChatSidebar，扩展路由**

将文件末尾的实例化和监听替换为：

```js
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
    case 'SEND_TO_CHAT': {
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
```

- [ ] **Step 5: Commit**

```bash
git add src/content/index.js
git commit -m "feat: add ChatSidebar class and wire send-to-chat flow in content script"
```

---

## Task 6: 修复 background 中 TRANSLATE_START 传递 originalText，处理 SEND_TO_CHAT

**Files:**
- Modify: `src/background/index.js`

- [ ] **Step 1: TRANSLATE_START 消息带上 originalText**

在 `src/background/index.js` 中，将：

```js
chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_START, payload: { position } });
```

改为：

```js
chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_START, payload: { position, originalText: text } });
```

- [ ] **Step 2: 新增 SAVE_ROLE_PROMPT 消息路由**

在 `chrome.runtime.onMessage.addListener` 的处理块里，在 SWITCH_PROVIDER 判断之后新增：

```js
  if (message.type === 'SAVE_ROLE_PROMPT') {
    chrome.storage.local.set({ rolePrompt: message.payload.value });
    return false;
  }
```

- [ ] **Step 3: 新增 SEND_TO_CHAT 路由（background 转发给 content）**

`SEND_TO_CHAT` 消息由 content script 内部发给 background 再转回 content（因为 Shadow DOM 内无法直接跨实例通信）。在监听器中新增：

```js
  if (message.type === 'SEND_TO_CHAT') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SEND_TO_CHAT',
        payload: message.payload,
      });
    }
    return false;
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/background/index.js
git commit -m "feat: pass originalText to TRANSLATE_START, add SEND_TO_CHAT relay and SAVE_ROLE_PROMPT"
```

---

## Task 7: 手动验证

- [ ] **Step 1: 在 Edge 中加载插件**

打开 `edge://extensions`，开启「开发者模式」，点「加载解压缩的扩展」，选择 `e:\Browser_ChaJian`。

- [ ] **Step 2: 验证划词翻译带角色**

1. 打开任意网页，在侧边栏顶部输入"你是法律专业的人"
2. 划选一段英文，按 `Ctrl+Shift+T`
3. 确认翻译结果带有法律专业风格

- [ ] **Step 3: 验证送入聊天**

1. 划词翻译完成后，点击浮窗底部「送入聊天」
2. 确认右侧边栏弹出，原文+译文作为用户气泡显示（右对齐蓝色）
3. 浮窗关闭

- [ ] **Step 4: 验证多轮对话**

1. 在侧边栏输入框输入"这段话的法律含义是什么？"，按 Enter
2. 确认用户气泡出现（右对齐），AI 流式回复出现（左对齐灰色），有光标动画
3. 回复完成后继续追问，验证上下文保留

- [ ] **Step 5: 验证跨页面历史保留**

1. 新开一个标签页，侧边栏应显示同一份聊天记录
2. 点击「清空对话」，历史清空
3. 关闭并重开浏览器，历史已清空（storage 在浏览器关闭时不自动清，这符合设计——仅手动清空）

> 注意：`chrome.storage.local` 本身在浏览器关闭后不会自动清空。如用户希望"关闭浏览器清空"，需后续额外实现（使用 `chrome.storage.session` 或 background 监听 `chrome.windows.onRemoved`）。当前版本按手动清空实现，符合用户确认的方案 C。
