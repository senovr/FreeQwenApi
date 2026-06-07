// chatId generation + mapping + Qwen chat resolution
// Extracted verbatim from routes.js

import crypto from 'crypto';
import { logInfo, logDebug } from '../../logger/index.js';
import { createChatV2 } from '../chat.js';
import { normalizeIdValue } from './messageParsing.js';

/**
 * Produce a deterministic internal chat ID from a message history.
 *
 * Filters out Open WebUI service user messages that start with "### Task:" or "History:"; if that removes all messages, the original history is used. The function derives a string from the first user message (string content as-is, otherwise JSON-stringified), hashes it with SHA-256, and returns an ID in the form `chat_<hash>`.
 *
 * @param {Array<object>} messages - Conversation history array of message objects with at least a `role` and `content` property.
 * @returns {string|null} `chat_<hash>` where `<hash>` is the first 16 hex characters of the SHA-256 of the derived user message, or `null` if an ID cannot be generated (invalid/empty input or no usable user message).
 */
export function generateChatIdFromHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    
    // Фильтруем служебные сообщения Open WebUI
    // Игнорируем сообщения, которые начинаются с "### Task:" или "History:"
    const realMessages = messages.filter(m => {
        if (m.role !== 'user') return true;
        const content = typeof m.content === 'string' ? m.content : '';
        return !content.startsWith('### Task:') && !content.startsWith('History:');
    });
    
    // Если остались только служебные сообщения, используем исходные
    const messagesToUse = realMessages.length > 0 ? realMessages : messages;
    
    // Используем хеш первого реального сообщения пользователя для создания стабильного ID
    const userMessages = messagesToUse
        .filter(m => m.role === 'user')
        .slice(0, 1) // Берём первое сообщение пользователя
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('||');
    
    if (!userMessages) return null;
    
    // Создаём хеш для детерминированного ID
    const hash = crypto
        .createHash('sha256')
        .update(userMessages)
        .digest('hex')
        .substring(0, 16);
    
    return `chat_${hash}`;
}

/**
 * Create a deterministic internal chat identifier derived from a hint.
 * @param {any} hint - Value used to derive the identifier; will be normalized before hashing.
 * @returns {string|null} `chat_<hash>` where `<hash>` is the first 16 hex characters of the SHA-256 of `client-conversation:<normalizedHint>`, or `null` if the hint is falsy after normalization.
 */
export function buildInternalChatIdFromHint(hint) {
    const normalizedHint = normalizeIdValue(hint);
    if (!normalizedHint) return null;

    const hash = crypto
        .createHash('sha256')
        .update(`client-conversation:${normalizedHint}`)
        .digest('hex')
        .substring(0, 16);

    return `chat_${hash}`;
}

// Глобальное хранилище для маппинга между сгенерированными ID и реальными Qwen chatId
const chatIdMap = new Map();

export { chatIdMap };

/**
 * Store an association between an internal generated chat ID and a Qwen chatId.
 * @param {string} generatedId - The internal chat identifier (e.g., `chat_<hash>`). If falsy, no mapping is stored.
 * @param {string} qwenChatId - The resolved Qwen chatId to associate with `generatedId`.
 */
export function mapChatId(generatedId, qwenChatId) {
    if (generatedId) {
        chatIdMap.set(generatedId, qwenChatId);
        logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
    }
}

/**
 * Retrieve the resolved Qwen chatId for an internal generated chat id.
 *
 * @param {string} generatedId - The internal `chat_<hash>` id previously generated.
 * @returns {string|undefined|null} The mapped Qwen `chatId` if a mapping exists, `undefined` if no mapping is stored, or `null` if `generatedId` is falsy.
 */
export function getChatIdFromMap(generatedId) {
    return generatedId ? chatIdMap.get(generatedId) : null;
}

/**
 * Resolve the Qwen chatId corresponding to an internal chat identifier, creating and binding a new Qwen chat if necessary.
 *
 * Attempts to return an already-mapped Qwen chatId for the provided `effectiveChatId`. If no mapping exists and
 * `effectiveChatId` starts with `"chat_"`, attempts to create a Qwen chat using `mappedModel`, stores the mapping,
 * and returns the created chatId. Creation errors are caught and only affect mapping/creation attempts.
 *
 * @param {string|null|undefined} effectiveChatId - The internal chat identifier to resolve (e.g., `chat_<hash>`).
 * @param {object} mappedModel - The model/client used to create a new Qwen chat when needed.
 * @returns {string|null|undefined} The resolved Qwen `chatId` string if found or created; otherwise the original `effectiveChatId` or `null`/`undefined` if none.
 */
export async function resolveQwenChatId(effectiveChatId, mappedModel) {
    let qwenChatId = effectiveChatId;
    const mapped = getChatIdFromMap(effectiveChatId);

    if (mapped) {
        qwenChatId = mapped;
        logInfo(`🔁 Используется сопоставленный Qwen chatId: ${qwenChatId} (from ${effectiveChatId})`);
        return qwenChatId;
    }

    if (effectiveChatId && effectiveChatId.startsWith('chat_')) {
        try {
            const created = await createChatV2(mappedModel, 'Сессия OpenWebUI');
            if (created && created.chatId) {
                mapChatId(effectiveChatId, created.chatId);
                qwenChatId = created.chatId;
                logInfo(`🔨 Создан Qwen chat ${qwenChatId} и привязан к ${effectiveChatId}`);
            }
        } catch (error) {
            logDebug(`Не удалось создать Qwen chat для ${effectiveChatId}: ${error.message}`);
        }
    }

    return qwenChatId;
}
