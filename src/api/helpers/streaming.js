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
 * Send a single Server-Sent Event message by writing a JSON-serialized `data:` chunk to the response.
 * @param {import('express').Response} res - Express response object (should have SSE headers set).
 * @param {object} payload - The payload to serialize and send as the event's `data` field.
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
 * Constructs an OpenAI-style `chat.completion.chunk` object for SSE streaming.
 *
 * @param {string} model - Model identifier to include in the chunk; when falsy, defaults to `'qwen-max-latest'`.
 * @param {object} delta - Partial response content to place in `choices[0].delta`.
 * @param {string|null} finishReason - Value for `choices[0].finish_reason`, or `null` if not finished.
 * @returns {object} A chunk with `id`, `object`, `created` (unix seconds), `model`, and `choices` containing the provided `delta` and `finish_reason`.
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
 * @param {string} model - Model identifier to include in the SSE chunk.
 * @param {string} errorMessage - Error message to send as the chunk's content.
 */
export function sendSseError(res, model, errorMessage) {
    writeSseChunk(res, buildChunk(model, { content: errorMessage }, 'stop'));
    sendSseDone(res);
}

/**
 * Send a non-streaming chat completion HTTP JSON response based on a sendMessage result.
 *
 * If `result.error` is present, responds with HTTP 500 and a JSON error object:
 * `{ error: { message: result.error, type: 'server_error' } }`. Otherwise responds with a
 * chat completion object that fills defaults for `id`, `created`, `model`, `choices`, and `usage`
 * while preserving `chatId` and `parentId` from `result`.
 *
 * @param {import('express').Response} res - Express response object used to send the HTTP reply.
 * @param {object} result - Result returned from sendMessage; may contain `error`, `id`, `model`,
 *   `choices`, `usage`, `chatId`, and `parentId`.
 * @param {string} mappedModel - Fallback model name to use when `result.model` is not provided.
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
