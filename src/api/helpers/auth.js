// API key Bearer token middleware
// Extracted verbatim from routes.js

import { getApiKeys } from '../chat.js';
import { logError } from '../../logger/index.js';

/**
 * Authenticate incoming requests using a configured list of API keys via the `Authorization: Bearer <token>` header.
 *
 * If no API keys are configured, authentication is skipped and control is passed to the next middleware. If the
 * `Authorization` header is missing or does not start with `Bearer `, responds with HTTP 401 and JSON `{ error: 'Требуется авторизация' }`.
 * If the provided token is not one of the configured API keys, responds with HTTP 401 and JSON `{ error: 'Недействительный токен' }`.
 */
export function authMiddleware(req, res, next) {
    const apiKeys = getApiKeys();
    if (apiKeys.length === 0) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logError('Отсутствует или некорректный заголовок авторизации');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.substring(7).trim();
    if (!apiKeys.includes(token)) {
        logError('Предоставлен недействительный API ключ');
        return res.status(401).json({ error: 'Недействительный токен' });
    }
    next();
}
