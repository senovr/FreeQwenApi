// Session key management + chatId save/restore + cleanup timer
// Extracted verbatim from routes.js

import crypto from 'crypto';
import { logDebug } from '../../logger/index.js';
import { ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from '../../config.js';
import { normalizeIdValue } from './messageParsing.js';

// ============================================
// СЕССИОННАЯ СИСТЕМА ДЛЯ ОТСЛЕЖИВАНИЯ ЧАТОВ
// ============================================
// Scoped-сессии (по conversation_id/chat_id) включены всегда.
// Unscoped fallback по IP + User-Agent работает только в legacy-режиме
// через ALLOW_UNSCOPED_SESSION_CHAT_RESTORE=true.
const sessionToChatMap = new Map(); // session-key -> {chatId, parentId, timestamp}

export { sessionToChatMap };

export function shouldPersistSessionContext(scope = null) {
    const normalizedScope = normalizeIdValue(scope);
    return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

export function getSessionKey(req) {
    // Создаём уникальный ключ сессии на основе IP и User-Agent
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return crypto.createHash('sha256').update(`${ip}||${userAgent}`).digest('hex');
}

export function getScopedSessionKey(req, scope = null) {
    const baseKey = getSessionKey(req);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

export function getSavedChatId(req, scope = null) {
    const keysToTry = [getScopedSessionKey(req, scope)];

    for (const sessionKey of keysToTry) {
        const sessionData = sessionToChatMap.get(sessionKey);
        if (sessionData && (Date.now() - sessionData.timestamp) < 3600000) { // 1 hour
            return sessionData;
        }
    }

    return null;
}

export function saveChatIdForSession(req, chatId, parentId, scope = null) {
    const sessionKey = getScopedSessionKey(req, scope);
    const normalizedScope = normalizeIdValue(scope);

    sessionToChatMap.set(sessionKey, {
        chatId,
        parentId,
        scope: normalizedScope,
        timestamp: Date.now()
    });

    const scopeSuffix = normalizedScope ? ` (scope=${normalizedScope})` : "";
    logDebug(`Saved chatId ${chatId} for session ${sessionKey.substring(0, 8)}${scopeSuffix}`);
}

// Очистка старых сессий каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    let cleaned = 0;
    for (const [key, value] of sessionToChatMap.entries()) {
        if (value.timestamp < oneHourAgo) {
            sessionToChatMap.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        logDebug(`Очищено ${cleaned} старых сессий`);
    }
}, 600000); // 10 минут
