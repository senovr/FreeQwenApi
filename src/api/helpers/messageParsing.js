// OpenAI message parsing + normalization utilities
// Extracted verbatim from routes.js — all pure functions, no external dependencies

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

export function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdValue(candidate);
        if (normalized) return normalized;
    }
    return null;
}

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

export function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

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
