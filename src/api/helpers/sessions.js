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

/**
 * Determine whether session chat context should be persisted for a given scope.
 *
 * @param {string|null} scope - Optional scope identifier used to create a scoped session key; may be null.
 * @returns {boolean} `true` if the normalized scope is non-empty or if unscoped session restore is allowed; `false` otherwise.
 */
export function shouldPersistSessionContext(scope = null) {
    const normalizedScope = normalizeIdValue(scope);
    return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

/**
 * Compute a deterministic session key from the request's IP and User-Agent.
 * @param {import('express').Request} req - Express request object whose IP and `User-Agent` header are used.
 * @returns {string} Hex-encoded SHA-256 digest representing the derived session key.
 */
export function getSessionKey(req) {
    // Создаём уникальный ключ сессии на основе IP и User-Agent
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return crypto.createHash('sha256').update(`${ip}||${userAgent}`).digest('hex');
}

/**
 * Compute a session key for the given request, optionally namespaced by a normalized scope.
 * @param {import('http').IncomingMessage & { get?: (header: string) => string }} req - HTTP request used to derive the base session key (IP and user-agent).
 * @param {string|null} [scope=null] - Optional identifier that will be normalized and appended to the base key when non-empty.
 * @returns {string} The session key; returns `${baseKey}::${normalizedScope}` when a normalized scope is present, otherwise the base key.
 */
export function getScopedSessionKey(req, scope = null) {
    const baseKey = getSessionKey(req);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

/**
 * Retrieve saved session chat context for the request and optional scope if it exists and is not older than one hour.
 * @param {import('express').Request} req - HTTP request used to derive the session key.
 * @param {string|null} [scope=null] - Optional scope identifier used to compute a scoped session key; the value is normalized before use.
 * @returns {{chatId: string, parentId: string|null, scope: string|null, timestamp: number}|null} `{chatId, parentId, scope, timestamp}` if a valid saved session exists (younger than 1 hour), `null` otherwise.
 */
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

/**
 * Store chat context (chatId and parentId) under the session key derived from the request and optional scope.
 *
 * Saves an entry containing `chatId`, `parentId`, the normalized `scope`, and the current timestamp so the session's chat context can be restored later.
 *
 * @param {import('express').Request} req - HTTP request used to derive the session key (based on IP and User-Agent).
 * @param {string} chatId - Identifier of the chat to associate with the session.
 * @param {string|undefined|null} parentId - Optional parent message ID within the chat.
 * @param {string|undefined|null} scope - Optional scope identifier; will be normalized before storage.
 */
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
