import { MSG, STORAGE_KEY } from '../shared/constants.js';

const select = document.getElementById('provider-select');
const noProvider = document.getElementById('no-provider');
const optionsLink = document.getElementById('options-link');

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function load() {
  const result = await chrome.storage.local.get([STORAGE_KEY.PROVIDERS, STORAGE_KEY.ACTIVE_ID]);
  const providers = result[STORAGE_KEY.PROVIDERS] || [];
  const activeId = result[STORAGE_KEY.ACTIVE_ID];

  if (!providers.length) {
    select.style.display = 'none';
    noProvider.style.display = 'block';
    return;
  }

  select.style.display = '';
  noProvider.style.display = 'none';
  select.innerHTML = '';

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    select.appendChild(opt);
  }
}

select.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: MSG.SWITCH_PROVIDER, payload: { id: select.value } });
});

load();
