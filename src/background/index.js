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

  chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_START, payload: { position, originalText: text } });

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

  if (message.type === 'SEND_TO_CHAT') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'SEND_TO_CHAT', payload: message.payload });
    }
    return false;
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

      const systemContent = rolePrompt
        ? `你是一名专业助手。${rolePrompt}。请根据用户的要求回答，用户让你翻译才翻译，否则正常对话。`
        : '你是一名专业助手。请根据用户的要求回答，用户让你翻译才翻译，否则正常对话。';

      const userMsg = { role: 'user', content: message.payload.content };
      const messages = [
        { role: 'system', content: systemContent },
        ...history,
        userMsg,
      ];

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
