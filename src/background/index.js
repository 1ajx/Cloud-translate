import { MSG } from '../shared/constants.js';
import { getActiveProvider } from './config-store.js';
import { translate } from './api-client.js';

// 快捷键触发翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // 1. 向 content script 获取选中文本
  let selectionResult;
  try {
    selectionResult = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_SELECTION });
  } catch {
    return; // content script 未就绪（如 edge:// 页面）
  }

  const { text, position } = selectionResult || {};
  if (!text?.trim()) return;

  // 2. 通知 content script 准备显示浮窗
  chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_START, payload: { position } });

  // 3. 读取当前 Provider
  const provider = await getActiveProvider();
  if (!provider) {
    chrome.tabs.sendMessage(tab.id, {
      type: MSG.TRANSLATE_ERROR,
      payload: { message: '未配置任何模型，请先前往选项页添加 Provider。' },
    });
    return;
  }

  // 4. 调用 API，流式转发
  await translate(
    text,
    provider,
    (chunk) => chrome.tabs.sendMessage(tab.id, { type: MSG.STREAM_CHUNK, payload: { chunk } }),
    () => chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_DONE }),
    (message) => chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_ERROR, payload: { message } }),
  );
});

// Popup 切换 Provider
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MSG.SWITCH_PROVIDER) {
    import('./config-store.js').then(({ setActiveProviderId }) => {
      setActiveProviderId(message.payload.id).then(() => sendResponse({ ok: true }));
    });
    return true; // 异步响应
  }
});
