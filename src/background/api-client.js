/**
 * 调用模型 API 进行翻译，支持 SSE 流式输出。
 * @param {string} text - 待翻译文本
 * @param {object} provider - Provider 配置对象
 * @param {function} onChunk - 收到译文片段时回调 (chunk: string) => void
 * @param {function} onDone - 翻译完成时回调 () => void
 * @param {function} onError - 出错时回调 (message: string) => void
 */
export async function translate(text, provider, onChunk, onDone, onError) {
  const url = `${provider.baseURL}/chat/completions`;
  const body = {
    model: provider.model,
    stream: true,
    temperature: provider.temperature ?? 0.3,
    max_tokens: provider.maxTokens ?? 4096,
    messages: [
      {
        role: 'system',
        content: '你是一名专业翻译。将用户提供的文本翻译成中文，只输出译文，不加解释。如果原文已是中文，则翻译成英文。',
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
