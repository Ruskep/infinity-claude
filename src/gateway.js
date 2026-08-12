async function listModels(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey || ''}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

async function streamChat({
  baseUrl, apiKey, model, messages, tools, temperature, maxTokens,
  topP, presencePenalty, frequencyPenalty, seed, streamIdleMs = 45000, requestTimeoutMs,
  signal, onContent
}) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const body = {
    model,
    messages,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    max_tokens: maxTokens || undefined
  };
  if (typeof topP === 'number') body.top_p = topP;
  if (typeof presencePenalty === 'number') body.presence_penalty = presencePenalty;
  if (typeof frequencyPenalty === 'number') body.frequency_penalty = frequencyPenalty;
  if (typeof seed === 'number') body.seed = seed;
  if (tools && tools.length) body.tools = tools;

  try {
    const signals = [signal].filter(Boolean);
    if (requestTimeoutMs) signals.push(AbortSignal.timeout(requestTimeoutMs));
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || ''}`
      },
      body: JSON.stringify(body),
      signal: signals.length > 1 ? AbortSignal.any(signals) : (signals[0] || undefined)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let usage = null;

    // аккумуляция tool_calls по индексу
    const toolCallsByIdx = new Map();
    let finishReason = null;

    const flushLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      if (!data) return;
      try {
        const json = JSON.parse(data);
        const choice = json.choices && json.choices[0];
        if (!choice) return;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          fullText += delta.content;
          if (onContent) onContent(delta.content, fullText);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            let slot = toolCallsByIdx.get(tc.index);
            if (!slot) {
              slot = { id: tc.id || '', name: '', arguments: '' };
              toolCallsByIdx.set(tc.index, slot);
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function) {
              if (tc.function.name) slot.name = tc.function.name;
              if (tc.function.arguments) slot.arguments += tc.function.arguments;
            }
          }
        }

        if (json.usage) usage = json.usage;
      } catch (_) { /* keepalive etc */ }
    };

    // таймаут молчания: если от шлюза N секунд нет НИКАКИХ данных (не даже heartbeat),
    // снимаем стрим и возвращаем что накопили, чтобы не висеть на «трёх точках» вечно.
    const idleMs = streamIdleMs;
    let lastActivity = Date.now();
    let idleTimedOut = false;
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > idleMs) {
        idleTimedOut = true;
        reader.cancel().catch(() => {});
        clearInterval(idleTimer);
      }
    }, 5000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (idleTimedOut) break;
      lastActivity = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      let sawData = false;
      for (const line of lines) { flushLine(line); if (line.trim().startsWith('data:')) sawData = true; }
      if (sawData) lastActivity = Date.now();
    }
    clearInterval(idleTimer);
    if (buffer.trim()) flushLine(buffer);

    if (idleTimedOut && !fullText && toolCallsByIdx.size === 0) {
      return { ok: false, message: 'Шлюз молчит более ' + Math.round(idleMs / 1000) + 'с — соединение прервано по таймауту.' };
    }

    const toolCalls = Array.from(toolCallsByIdx.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => ({
        id: v.id || `call_${Date.now()}_${idx}`,
        name: v.name,
        arguments: v.arguments
      }))
      .filter((tc) => tc.name);

    return { ok: true, text: fullText, usage, toolCalls, finishReason, idleTimedOut };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, message: err && err.message ? err.message : String(err) };
  }
}

module.exports = { listModels, streamChat };