// SSE streaming utilities — HTTP response side only (per D-09, D-10)
// Extracted from routes.js inline SSE patterns

/**
 * Set SSE response headers on the Express response object.
 * @param {import('express').Response} res
 */
export function setSseHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Transfer-Encoding', 'chunked');
}

/**
 * Write a single SSE data chunk.
 * @param {import('express').Response} res
 * @param {object} payload - The JSON payload to send
 */
export function writeSseChunk(res, payload) {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

/**
 * Write the [DONE] sentinel and end the response.
 * @param {import('express').Response} res
 */
export function sendSseDone(res) {
    res.write('data: [DONE]\n\n');
    res.end();
}

/**
 * Build an OpenAI-format SSE chunk.
 * @param {string} model
 * @param {object} delta - The delta content
 * @param {string|null} finishReason
 * @returns {object}
 */
export function buildChunk(model, delta, finishReason = null) {
    return {
        id: 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'qwen-max-latest',
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
}

/**
 * Send an SSE error chunk and terminate the stream.
 * @param {import('express').Response} res
 * @param {string} model
 * @param {string} errorMessage
 */
export function sendSseError(res, model, errorMessage) {
    writeSseChunk(res, buildChunk(model, { content: errorMessage }, 'stop'));
    sendSseDone(res);
}

/**
 * Handle a non-streaming chat completion response.
 * @param {import('express').Response} res
 * @param {object} result - The result from sendMessage
 * @param {string} mappedModel - The mapped model name
 */
export function handleNonStreamingResponse(res, result, mappedModel) {
    if (result.error) {
        return res.status(500).json({ error: { message: result.error, type: 'server_error' } });
    }

    res.json({
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel,
        choices: result.choices || [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId
    });
}
