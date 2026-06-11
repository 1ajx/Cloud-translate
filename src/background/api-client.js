/**
 * 调用模型 API 进行翻译，支持 SSE 流式输出。
 * @param {string} text - 待翻译文本
 * @param {object} provider - Provider 配置对象
 * @param {string} rolePrompt - 角色提示词（可选）
 * @param {function} onChunk - 收到译文片段时回调 (chunk: string) => void
 * @param {function} onDone - 翻译完成时回调 () => void
 * @param {function} onError - 出错时回调 (message: string) => void
 */
export async function translate(text, provider, rolePrompt, onChunk, onDone, onError) {
  const url = `${provider.baseURL}/chat/completions`;
  const systemContent = rolePrompt
    ? `你是一名专业翻译。默认将文本翻译成中文（若原文已是中文，则翻译成英文）。只输出译文，不加解释。如有额外指定，以指定为准。\n用户指定：${rolePrompt}`
    : '你是一名专业翻译。将用户提供的文本翻译成中文，只输出译文，不加解释。如果原文已是中文，则翻译成英文。';

  const body = {
    model: provider.model,
    stream: true,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    messages: [
      {
        role: 'system',
        content: systemContent,
      },
      {
        role: 'user',
        content: text,
      },
    ],
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
    let msg = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      msg = json.error?.message || msg;
    } catch {}
    onError(msg);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留未完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const chunk = json.choices?.[0]?.delta?.content;
          if (chunk) onChunk(chunk);
        } catch {}
      }
    }
    onDone();
  } catch (e) {
    onError(`流读取错误：${e.message}`);
  }
}

/**
 * 整页翻译：批量翻译多个文本块（非流式），要求模型保留占位符标记并按 JSON 返回。
 * @param {Array<{id: string, text: string}>} items - 待翻译块
 * @param {object} provider - Provider 配置对象
 * @param {string} rolePrompt - 角色提示词（可选）
 * @returns {Promise<Array<{id: string, text: string}>>} 译文数组（解析失败时整批重试一次，仍失败则抛错）
 */
export async function translateBatch(items, provider, rolePrompt) {
  const url = `${provider.baseURL}/chat/completions`;
  let systemContent =
    '你是网页翻译引擎。用户输入一个 JSON 数组，每项形如 {"id":"...","text":"..."}。' +
    '把每项的 text 翻译成中文（若已是中文则原样保留）。' +
    'text 中形如 <x0>...</x0> 或 <x1/> 的标记必须在译文的对应位置原样保留，数量不得增减，标记内的文字照常翻译。' +
    '只输出 JSON 数组，每项 {"id":"...","text":"译文"}，不要输出任何解释或代码块标记。';
  if (rolePrompt) systemContent += `\n用户补充要求：${rolePrompt}`;

  const body = JSON.stringify({
    model: provider.model,
    stream: false,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: JSON.stringify(items) },
    ],
  });

  const attempt = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body,
    });
    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        msg = json.error?.message || msg;
      } catch {}
      throw new Error(msg);
    }
    const json = await response.json();
    let content = json.choices?.[0]?.message?.content || '';
    // 容错：剥掉可能的 markdown 代码块包裹
    content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('返回格式不是数组');
    return parsed
      .filter((it) => it && typeof it.id === 'string' && typeof it.text === 'string')
      .map((it) => ({ id: it.id, text: it.text }));
  };

  try {
    return await attempt();
  } catch {
    return await attempt(); // 整批重试一次
  }
}

/**
 * 多轮聊天请求，支持 SSE 流式输出。
 * @param {Array} messages - OpenAI messages 数组（含历史）
 * @param {object} provider - Provider 配置对象
 * @param {function} onChunk - 收到回复片段时回调 (chunk: string) => void
 * @param {function} onDone - 聊天完成时回调 () => void
 * @param {function} onError - 出错时回调 (message: string) => void
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
    let msg = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      msg = json.error?.message || msg;
    } catch {}
    onError(msg);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留未完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const chunk = json.choices?.[0]?.delta?.content;
          if (chunk) onChunk(chunk);
        } catch {}
      }
    }
    onDone();
  } catch (e) {
    onError(`流读取错误：${e.message}`);
  }
}
