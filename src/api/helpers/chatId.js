// chatId generation + mapping + Qwen chat resolution
// Extracted verbatim from routes.js

import crypto from 'crypto';
import { logInfo, logDebug } from '../../logger/index.js';
import { createChatV2 } from '../chat.js';
import { normalizeIdValue } from './messageParsing.js';

// Функция для генерирования детерминированного chatId на основе истории
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

export function mapChatId(generatedId, qwenChatId) {
    if (generatedId) {
        chatIdMap.set(generatedId, qwenChatId);
        logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
    }
}

export function getChatIdFromMap(generatedId) {
    return generatedId ? chatIdMap.get(generatedId) : null;
}

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
