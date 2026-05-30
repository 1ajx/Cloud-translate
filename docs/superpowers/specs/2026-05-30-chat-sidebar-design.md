# Chat Sidebar 设计文档

**日期:** 2026-05-30  
**功能:** 右侧聊天侧边栏 + 角色/背景设定 + 送入聊天

---

## 1. 功能概述

在现有划词翻译插件基础上，新增一个可交互的右侧聊天侧边栏，让用户可以：
- 将划词翻译结果送入聊天，与 AI 进行深度对话
- 设定专业角色/翻译背景，全局影响所有翻译和对话
- 像普通 AI 对话框一样与模型自由聊天

---

## 2. 架构

### 技术方案
content script 注入 div + Shadow DOM，与现有 FloatingPanel 架构一致。侧边栏作为独立类 `ChatSidebar` 实现，注入到页面右侧固定定位。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/content/chat-sidebar.js` | `ChatSidebar` 类：侧边栏 DOM、消息渲染、宽度拖拽 |
| `src/content/sidebar.css` | 侧边栏 Shadow DOM 内部样式 |

### 修改文件

| 文件 | 变动 |
|------|------|
| `src/content/floating-panel.js` | `done()` 里新增「送入聊天」按钮 |
| `src/content/index.js` | 实例化 `ChatSidebar`，处理 `SEND_TO_CHAT` 消息 |
| `src/background/api-client.js` | 新增 `chat(messages, provider, onChunk, onDone, onError)` 函数 |
| `src/background/index.js` | 新增 `CHAT_SEND` 消息路由 |
| `src/shared/constants.js` | 新增 `MSG.CHAT_SEND`、`MSG.SEND_TO_CHAT`、`STORAGE_KEY.CHAT_HISTORY`、`STORAGE_KEY.ROLE_PROMPT` |
| `src/background/config-store.js` | 新增 `getRolePrompt()`、`saveRolePrompt()`、`getChatHistory()`、`saveChatHistory()` |

---

## 3. 数据流

### 划词翻译（修改 system prompt）
```
快捷键触发
→ background 读 rolePrompt（from storage）
→ 注入 system prompt："你是专业翻译。{rolePrompt}" + 翻译指令
→ 单次请求，不带历史
→ 浮窗显示结果
```

### 送入聊天
```
用户点击浮窗「送入聊天」按钮
→ content 构造消息对象 { role: 'user', content: '原文：...\n译文：...' }
→ 追加到 chatHistory，保存到 storage
→ 侧边栏打开并显示该消息气泡（右侧，用户气泡）
（不再调用 AI，浮窗译文直接搬入，无需重复请求）
```

### 用户在侧边栏追问
```
用户输入任意内容 → 追加为 user 消息 → 保存 storage
→ content 发 CHAT_SEND 到 background
→ background 读 chatHistory + rolePrompt
→ 构造 messages 数组（system: rolePrompt，历史消息）
→ 调用 chat() 流式请求
→ stream chunk 回传 content → 侧边栏追加到 AI 气泡（左侧）
→ 完成后追加 assistant 消息到 history，保存 storage
```

### 角色/背景设定
```
用户在侧边栏顶部输入框输入
→ 实时（debounce 500ms）保存到 chrome.storage.local[STORAGE_KEY.ROLE_PROMPT]
→ 下次翻译或对话时自动读取生效
```

---

## 4. UI 结构

### 侧边栏
- 固定在页面右侧，`position: fixed; right: 0; top: 0; height: 100vh`
- 默认宽度 380px，范围 200px ~ 600px
- 左边缘有拖拽条，拖拽时实时调整宽度
- 页面 `document.body` 的 `margin-right` 跟随侧边栏宽度，避免内容被遮挡
- 侧边栏通过 `transform: translateX(100%)` 隐藏，`translateX(0)` 显示，CSS transition 滑入动画

### 布局（从上到下）
```
┌─────────────────────────────┐
│ 角色/背景: [____________] [清空对话] │  ← 顶部固定
├─────────────────────────────┤
│                             │
│         原文+译文气泡 ────▶ │  ← 用户气泡，右对齐，蓝色背景
│ ◀──── AI 回复气泡           │  ← AI 气泡，左对齐，灰色背景
│                用户追问 ──▶ │
│ ◀──── AI 回复               │
│                             │
├─────────────────────────────┤
│ [输入框 (textarea)]  [发送] │  ← 底部固定
└─────────────────────────────┘
```

### 消息气泡
- **用户气泡**：右对齐，蓝色背景，圆角
- **AI 气泡**：左对齐，浅灰背景，圆角，支持流式追加文字
- 流式输出时显示光标动画（与现有浮窗一致）

---

## 5. Storage 结构

```js
// 角色/背景设定
chrome.storage.local['rolePrompt'] = '你是测绘工程专业的人，请使用测绘专业术语翻译。'

// 聊天历史（OpenAI messages 格式）
chrome.storage.local['chatHistory'] = [
  { role: 'user', content: '原文：Survey control network\n译文：测量控制网' },
  { role: 'assistant', content: '好的，有什么想深入了解的？' },
  { role: 'user', content: '这个词在实际工程中怎么用？' },
  { role: 'assistant', content: '测量控制网是...' },
]
```

---

## 6. System Prompt 构造规则

```
// 基础翻译（快捷键划词）
system: `你是一名专业翻译。${rolePrompt ? rolePrompt + '。' : ''}将用户提供的文本翻译成中文，只输出译文，不加解释。如果原文已是中文，则翻译成英文。`

// 侧边栏对话
system: `你是一名专业助手。${rolePrompt ? rolePrompt + '。' : ''}请根据用户的要求回答，用户让你翻译才翻译，否则正常对话。`
```

---

## 7. 不在本次范围内

- 多轮对话历史的 token 上限控制（后续可按需加截断）
- 侧边栏对话导出
- 多套角色预设管理
