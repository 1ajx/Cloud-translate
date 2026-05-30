import { STORAGE_KEY, DEFAULT_PROVIDER_TEMPLATE } from '../shared/constants.js';
import { generateId } from '../shared/utils.js';

export async function getProviders() {
  const result = await chrome.storage.local.get(STORAGE_KEY.PROVIDERS);
  return result[STORAGE_KEY.PROVIDERS] || [];
}

export async function saveProviders(providers) {
  await chrome.storage.local.set({ [STORAGE_KEY.PROVIDERS]: providers });
}

export async function getActiveProviderId() {
  const result = await chrome.storage.local.get(STORAGE_KEY.ACTIVE_ID);
  return result[STORAGE_KEY.ACTIVE_ID] || null;
}

export async function setActiveProviderId(id) {
  await chrome.storage.local.set({ [STORAGE_KEY.ACTIVE_ID]: id });
}

export async function getActiveProvider() {
  const [providers, activeId] = await Promise.all([
    getProviders(),
    getActiveProviderId(),
  ]);
  if (!providers.length) return null;
  return providers.find(p => p.id === activeId) || providers[0];
}

export async function addProvider(data) {
  const providers = await getProviders();
  const newProvider = { ...DEFAULT_PROVIDER_TEMPLATE, ...data, id: generateId() };
  providers.push(newProvider);
  await saveProviders(providers);
  if (providers.length === 1) {
    await setActiveProviderId(newProvider.id);
  }
  return newProvider;
}

export async function updateProvider(id, data) {
  const providers = await getProviders();
  const idx = providers.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Provider ${id} not found`);
  providers[idx] = { ...providers[idx], ...data };
  await saveProviders(providers);
  return providers[idx];
}

export async function deleteProvider(id) {
  let providers = await getProviders();
  providers = providers.filter(p => p.id !== id);
  await saveProviders(providers);
  const activeId = await getActiveProviderId();
  if (activeId === id) {
    await setActiveProviderId(providers[0]?.id || null);
  }
}

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
