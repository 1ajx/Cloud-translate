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
  SEND_TO_CHAT: 'SEND_TO_CHAT',
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
