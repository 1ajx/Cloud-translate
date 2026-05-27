import {
  getProviders, getActiveProviderId, setActiveProviderId,
  addProvider, updateProvider, deleteProvider,
} from '../background/config-store.js';
import { DEFAULT_PROVIDER_TEMPLATE } from '../shared/constants.js';

const providerList = document.getElementById('provider-list');
const emptyState = document.getElementById('empty-state');
const providerForm = document.getElementById('provider-form');
const formTitle = document.getElementById('form-title');
const btnAdd = document.getElementById('btn-add');
const btnDelete = document.getElementById('btn-delete');
const btnSetDefault = document.getElementById('btn-set-default');
const btnToggleKey = document.getElementById('btn-toggle-key');
const shortcutLink = document.getElementById('shortcut-link');

const fName = document.getElementById('f-name');
const fBaseurl = document.getElementById('f-baseurl');
const fApikey = document.getElementById('f-apikey');
const fModel = document.getElementById('f-model');
const fTemperature = document.getElementById('f-temperature');

let currentId = null; // 当前编辑的 provider id（null = 新建）

shortcutLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

btnToggleKey.addEventListener('click', () => {
  fApikey.type = fApikey.type === 'password' ? 'text' : 'password';
});

async function renderList() {
  const [providers, activeId] = await Promise.all([getProviders(), getActiveProviderId()]);
  providerList.innerHTML = '';
  for (const p of providers) {
    const li = document.createElement('li');
    li.className = 'provider-item' + (p.id === currentId ? ' active' : '');
    li.dataset.id = p.id;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    li.appendChild(nameSpan);
    if (p.id === activeId) {
      const badge = document.createElement('span');
      badge.className = 'default-badge';
      badge.textContent = '★';
      li.appendChild(badge);
    }
    li.addEventListener('click', () => selectProvider(p.id));
    providerList.appendChild(li);
  }
}

async function selectProvider(id) {
  currentId = id;
  const providers = await getProviders();
  const p = providers.find(x => x.id === id);
  if (!p) return;

  emptyState.style.display = 'none';
  providerForm.style.display = '';
  formTitle.textContent = `编辑：${p.name}`;

  fName.value = p.name;
  fBaseurl.value = p.baseURL;
  fApikey.value = p.apiKey;
  fModel.value = p.model;
  fTemperature.value = p.temperature ?? 0.3;

  await renderList();
}

function showNewForm() {
  currentId = null;
  emptyState.style.display = 'none';
  providerForm.style.display = '';
  formTitle.textContent = '添加 Provider';

  fName.value = DEFAULT_PROVIDER_TEMPLATE.name;
  fBaseurl.value = DEFAULT_PROVIDER_TEMPLATE.baseURL;
  fApikey.value = '';
  fModel.value = DEFAULT_PROVIDER_TEMPLATE.model;
  fTemperature.value = DEFAULT_PROVIDER_TEMPLATE.temperature;

  // 取消列表高亮
  providerList.querySelectorAll('.provider-item').forEach(el => el.classList.remove('active'));
}

btnAdd.addEventListener('click', showNewForm);

providerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: fName.value.trim(),
    baseURL: fBaseurl.value.trim(),
    apiKey: fApikey.value.trim(),
    format: 'openai',
    model: fModel.value.trim(),
    temperature: parseFloat(fTemperature.value),
    maxTokens: 4096,
  };

  if (currentId) {
    await updateProvider(currentId, data);
  } else {
    const newP = await addProvider(data);
    currentId = newP.id;
  }

  await renderList();
  formTitle.textContent = `编辑：${data.name}`;
});

btnSetDefault.addEventListener('click', async () => {
  if (!currentId) return;
  await setActiveProviderId(currentId);
  await renderList();
});

btnDelete.addEventListener('click', async () => {
  if (!currentId) return;
  if (!confirm('确认删除此 Provider？')) return;
  await deleteProvider(currentId);
  currentId = null;
  providerForm.style.display = 'none';
  emptyState.style.display = 'flex';
  await renderList();
});

// 初始化
renderList();
