// OpenAI message parsing + normalization utilities
/**
 * Normalize various input values into a clean string identifier or `null`.
 *
 * Converts numbers and bigints to their string form, trims string inputs and
 * treats empty or whitespace-only strings as missing, and treats the literal
 * values `"null"` and `"undefined"` (case-insensitive) as missing.
 *
 * @param {*} value - The input value to normalize (may be string, number, bigint, etc.).
 * @returns {string|null} The normalized trimmed string identifier, or `null` if the value should be considered missing.
 */

export function normalizeIdValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;

    return trimmed;
}

/**
 * Select the first candidate that normalizes to a valid ID string.
 * @param {any[]} candidates - Ordered candidates to test for a valid ID.
 * @returns {string|null} The first normalized ID string, or `null` if none of the candidates yields a valid ID.
 */
export function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdValue(candidate);
        if (normalized) return normalized;
    }
    return null;
}

/**
 * Extracts a conversation or chat identifier hint from the request.
 *
 * Scans common locations for a conversation/chat id: request body top-level fields, a
 * body.metadata object, and several request headers. Uses normalization rules to
 * treat missing, empty, or explicit `"null"`/`"undefined"` values as absent.
 *
 * @param {object} req - Request-like object (may include `body` and `get(header)`).
 * @returns {string|null} The first valid normalized conversation/chat id, or `null` if none found.
 */
export function extractConversationHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        req.get?.('x-conversation-id'),
        req.get?.('x-openwebui-conversation-id'),
        req.get?.('x-chat-id'),
        req.get?.('x-openwebui-chat-id')
    ]);
}

/**
 * Extracts a normalized parent/thread identifier from an HTTP request.
 *
 * Checks body fields, nested `metadata`, and specific headers in a prioritized order and returns the first valid normalized identifier found.
 * @param {object} req - Express-like HTTP request object whose `body` and `get` header accessor may be consulted.
 * @returns {string|null} The first normalized parent identifier, or `null` if none is present.
 */
export function extractParentHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        req.get?.('x-parent-id'),
        req.get?.('x-openwebui-parent-id')
    ]);
}

/**
 * Determine whether a value represents a truthy flag.
 * @param {*} value - Value to interpret as a flag; accepts booleans, numbers, and strings.
 * @returns {boolean} `true` if `value` is the boolean `true`, the number `1`, or a string that (case-insensitively, with surrounding whitespace trimmed) equals `"1"`, `"true"`, `"yes"`, or `"on"`, `false` otherwise.
 */
export function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Determine whether the request signals that a new chat should be forced.
 *
 * Checks several body properties and header keys for common truthy flag representations; returns `true` if any indicate forcing a new chat, `false` otherwise.
 *
 * @param {object} req - HTTP request object; may include `body` and a `get(name)` header accessor.
 * @returns {boolean} `true` if any checked body fields (`newChat`, `new_chat`, `resetChat`, `reset_chat`) or headers (`x-new-chat`, `x-reset-chat`) represent a truthy flag, `false` otherwise.
 */
export function shouldForceNewChat(req) {
    const body = req.body || {};

    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        req.get?.('x-new-chat'),
        req.get?.('x-reset-chat')
    ].some(isTruthyFlag);
}

/**
 * Determines whether the last user message is an OpenWebUI meta/background prompt.
 *
 * @param {Array<object>} messages - Array of message objects; each message may include `role` and `content`.
 * @returns {boolean} `true` if the last user message is a background/meta prompt (starts with "### Task:" or "History:", or contains both "<chat_history>" and "### Task:"), `false` otherwise.
 */
export function isOpenWebUiMetaRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const lastUserMessage = messages.filter(m => m && m.role === 'user').pop();
    if (!lastUserMessage) return false;

    const content = lastUserMessage.content;
    if (Array.isArray(content)) return false; // multimodal / normal user message
    if (typeof content !== 'string') return false;

    const text = content.trimStart();

    // OpenWebUI background/meta prompts that should not reuse the main chatId/session.
    if (text.startsWith('### Task:')) return true;
    if (text.startsWith('History:')) return true;

    // Some variants embed history blocks and task instructions.
    if (text.includes('<chat_history>') && text.includes('### Task:')) return true;

    return false;
}

/**
 * Extracts the content of the last user message and the first system message from an OpenAI-style messages array.
 *
 * If a user message's `content` is an array, each item is normalized: items with `type: 'text'` become `{ type: 'text', text }`,
 * items with `type: 'image_url'` and an `image_url.url` become `{ type: 'image', image }`, and items with `type: 'image'` become `{ type: 'image', image }`.
 *
 * @param {Array<object>} messages - Array of message objects (each may include `role` and `content`).
 * @returns {{messageContent: null|string|Array<object>, systemMessage: any}} An object with:
 *   - `messageContent`: the `content` of the last message with `role === 'user'`, or `null` if none; if the content was an array it will be the normalized array described above.
 *   - `systemMessage`: the `content` of the first message with `role === 'system'`, or `null` if none.
 */
export function parseOpenAIMessages(messages) {
    const systemMsg = messages.find(msg => msg.role === 'system');
    const systemMessage = systemMsg ? systemMsg.content : null;
    const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
    
    if (!lastUserMessage) {
        return { messageContent: null, systemMessage };
    }
    
    let messageContent = lastUserMessage.content;
    
    // Преобразуем OpenAI format content array во внутренний формат
    if (Array.isArray(messageContent)) {
        messageContent = messageContent.map(item => {
            if (item.type === 'text') {
                return { type: 'text', text: item.text };
            } else if (item.type === 'image_url' && item.image_url) {
                // OpenAI format: image_url: { url: '...' }
                return { type: 'image', image: item.image_url.url };
            } else if (item.type === 'image') {
                // Уже во внутреннем формате
                return { type: 'image', image: item.image };
            }
            return item;
        });
    }
    
    return { messageContent, systemMessage };
}
