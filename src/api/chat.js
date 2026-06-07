import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import { setAuthToken, getAuthToken, isBrowserAvailable, setBrowserAvailable, registerClearPagePool } from './sharedState.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let availableModels = null;
let authKeys = null;
let browserTokenRateLimited = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Page helpers ────────────────────────────────────────────────────────────

async function getPage(context) {
    if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Если передана Puppeteer Page, не переиспользуем её как рабочую:
        // создаём отдельную вкладку из того же браузера, чтобы избежать гонок
        // и случайного закрытия базовой страницы.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Не удалось создать новую страницу из текущего контекста: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Базовая страница браузера закрыта');
        }

        return context;
    }

    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

export const pagePool = {
    pages: [],
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        const baseContext = getBrowserContext();
        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === baseContext) {
                    logWarn('Базовая страница не должна быть в пуле, пропускаем');
                    continue;
                }
                if (page.isClosed()) {
                    logWarn('Страница из пула закрыта, пропускаем');
                    continue;
                }
                await page.evaluate(() => document.readyState);
                return page;
            } catch (e) {
                logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
        }

        const newPage = await getPage(context);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!getAuthToken()) {
            try {
                const extractedToken = await newPage.evaluate(() => localStorage.getItem('token'));
                setAuthToken(extractedToken);
                logInfo('Токен авторизации получен из браузера');
                if (extractedToken) {
                    saveAuthToken(extractedToken);
                }
            } catch (e) {
                logError('Ошибка при получении токена авторизации', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }

        const baseContext = getBrowserContext();
        if (page === baseContext) {
            // Базовую страницу держим отдельно от пула.
            return;
        }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Ошибка при закрытии страницы', e));
        }
    },

    async clear() {
        const baseContext = getBrowserContext();
        for (const page of this.pages) {
            if (page === baseContext) continue;
            try { await page.close(); } catch (e) {
                logError('Ошибка при закрытии страницы в пуле', e);
            }
        }
        this.pages = [];
    }
};

// ─── Task polling ────────────────────────────────────────────────────────────

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL) {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }, { url: statusUrl, token });

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Задача завершилась ошибкой', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Превышен таймаут polling задачи' };
}

/**
 * Attempt to read an authentication token from the provided browser context's localStorage.
 * @param {object} context - A browser context or page used to access the chat page and localStorage.
 * @param {boolean} [forceRefresh=false] - If true, ignore any cached token and attempt extraction from the browser.
 * @returns {string|null} The extracted token if found (also stored via shared state and persisted), or `null` if no token could be obtained.
 */

export async function extractAuthToken(context, forceRefresh = false) {
    const currentToken = getAuthToken();
    if (currentToken && !forceRefresh) return currentToken;

    try {
        const page = await getPage(context);
        const shouldClosePage = page !== context;
        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const newToken = await page.evaluate(() => localStorage.getItem('token'));
            if (shouldClosePage) await page.close();

            if (newToken) {
                setAuthToken(newToken);
                logInfo('Токен авторизации успешно извлечен');
                saveAuthToken(newToken);
                return newToken;
            }
            logError('Токен авторизации не найден в браузере');
            return null;
        } catch (error) {
            if (shouldClosePage) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

// ─── Models & keys from files ────────────────────────────────────────────────

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
    return authKeys;
}

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

/**
 * Resolve an authentication token for API requests, preferring an available token and falling back to extracting one from the provided browser context.
 *
 * Attempts to use a pre-approved token from the token pool; if none is available and browser tokens are not rate-limited, ensures the browser is authenticated and extracts a token from browser storage. Persists the resolved token via setAuthToken.
 *
 * @param {Object} browserContext - Browser or page context used to check authentication and extract a token when needed.
 * @returns {{id: string, token: string}|null} An object with `id` and `token` when a token is resolved (`id` is `"browser"` for tokens extracted from the browser), or `null` if no token could be resolved (for example, when rate-limited or authentication fails).
 */
async function resolveAuthToken(browserContext) {
    const tokenObj = await getAvailableToken();
    if (tokenObj && tokenObj.token) {
        setAuthToken(tokenObj.token);
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        return tokenObj;
    }

    if (browserTokenRateLimited) {
        logWarn('Browser-токен залимичен, пропускаем fallback');
        return null;
    }

    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    if (!getAuthToken()) {
        logInfo('Получение токена авторизации...');
        setAuthToken(await extractAuthToken(browserContext));
    }

    const resolvedToken = getAuthToken();
    return resolvedToken ? { id: 'browser', token: resolvedToken } : null;
}

/**
 * Build the request payload for the upstream chat API for text or video conversations.
 *
 * Constructs a message object and payload configured for streaming or task-based (video) execution,
 * including model selection, parent/chat IDs, optional files, system message, tool integrations, and feature flags.
 *
 * @param {string|Array} messageContent - The user message content (string) or structured message array.
 * @param {string} model - Model identifier to use for the request.
 * @param {string|null} chatId - Target chat identifier; may be null for new chats.
 * @param {string|null} parentId - Parent message identifier within the chat; may be null.
 * @param {Array|null} files - Optional array of file descriptors to attach to the message.
 * @param {string|null} systemMessage - Optional system-level message to include in the payload.
 * @param {Array|null} tools - Optional array of tool definitions to enable for this message.
 * @param {string|null} toolChoice - Optional tool choice selection; defaults to `'auto'` when tools are provided.
 * @param {string} [chatType='t2t'] - Chat type: `'t2t'` for text or `'t2v'` for video (affects streaming and feature flags).
 * @param {string|null} size - Optional size parameter for generation (applied when provided).
 * @returns {Object} The assembled payload object suitable for sending to the upstream chat API.
 */
function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };
    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const newMessage = {
        fid: userMessageId,
        parentId, parent_id: parentId,
        role: 'user',
        content: messageContent,
        chat_type: chatType, sub_chat_type: chatType,
        timestamp: Math.floor(Date.now() / 1000),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        stream: !isVideo,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [newMessage],
        model,
        parent_id: parentId,
        timestamp: Math.floor(Date.now() / 1000)
    };

    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

function parseNonSseCompletionBody(body) {
    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode);

        if (hasStructuredError) {
            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
            return {
                success: false,
                status: isRateLimited ? 429 : 500,
                errorBody: body
            };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk) {
    try {
        if (!token) return { success: false, error: 'Токен авторизации не найден' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
            }
            return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }
                    if (chunk.error && !chunk.choices) {
                        streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }

                    if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                    if (chunk.response_id) responseId = chunk.response_id;

                    if (chunk.choices && chunk.choices[0]) {
                        const delta = chunk.choices[0].delta;
                        if (delta && delta.content) {
                            fullContent += delta.content;
                            if (typeof onChunk === 'function') {
                                onChunk(delta.content);
                                hasStreamedChunks = true;
                            }
                        }
                        if (delta && delta.status === 'finished') finished = true;
                        if (chunk.choices[0].finish_reason) finished = true;
                    }

                    if (chunk.usage) usage = chunk.usage;
                } catch {
                    // Ignore broken chunks, keep reading stream.
                }
            }
        }

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks };
        }

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            data: {
                id: responseId || 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                response_id: responseId
            }
        };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null) {
    if (payload?.stream !== false && typeof onChunk === 'function') {
        const streamedResponse = await executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk);

        const canReturnDirectly =
            streamedResponse.success ||
            Boolean(streamedResponse.status) ||
            Boolean(streamedResponse.errorBody) ||
            streamedResponse.hasStreamedChunks === true;

        if (canReturnDirectly) {
            return streamedResponse;
        }

        logWarn(`Node-streaming недоступен (${streamedResponse.error || 'unknown error'}), fallback к browser fetch.`);
    }

    const requestBody = { apiUrl, payload, token };

    logDebug(`Используем токен: ${token ? 'Токен существует' : 'Токен отсутствует'}`);
    logDebug(`API URL: ${apiUrl}`);

    return page.evaluate(async (data) => {
        try {
            const t = data.token;
            if (!t) return { success: false, error: 'Токен авторизации не найден' };

            const response = await fetch(data.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${t}`,
                    'Accept': '*/*'
                },
                body: JSON.stringify(data.payload)
            });

            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        const topLevelCode = parsed?.code;
                        const nestedCode = parsed?.data?.code;
                        const hasStructuredError =
                            parsed?.success === false ||
                            Boolean(parsed?.error) ||
                            Boolean(parsed?.data?.error) ||
                            Boolean(topLevelCode) ||
                            Boolean(nestedCode);

                        // API иногда возвращает JSON с success=false и code при HTTP 200.
                        if (hasStructuredError) {
                            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
                            return {
                                success: false,
                                status: isRateLimited ? 429 : 500,
                                errorBody: body
                            };
                        }
                        // Валидный JSON-ответ completion (иногда Qwen возвращает так)
                        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
                            return { success: true, isTask: false, data: parsed };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const delta = chunk.choices[0].delta;
                                if (delta && delta.content) fullContent += delta.content;
                                if (delta && delta.status === 'finished') finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
                }

                return {
                    success: true,
                    isTask: false,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        response_id: responseId
                    }
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
    }, requestBody);
}

/**
 * Handle errors returned by the upstream API and take recovery actions (token invalidation or rate-limit handling, browser verification restart, or retrying the request).
 *
 * @param {object} response - The upstream response object containing status, error, errorBody, html, and/or statusText.
 * @param {{id?:string,token?:string}|null} tokenObj - The token metadata used for the request; may include `id` to identify and mark tokens.
 * @param {string|object|Array} message - The original message payload passed to sendMessage; forwarded for retries.
 * @param {string} model - The model identifier used for the request.
 * @param {string|null} chatId - The chat identifier associated with the request.
 * @param {string|null} parentId - The parent message identifier for threading.
 * @param {Array|null} files - Any files attached to the original request.
 * @param {number} retryCount - Current retry attempt count.
 * @param {string} chatType - Chat type (e.g., 't2t' or 't2v').
 * @param {number|null} size - Optional size parameter used for generation.
 * @param {boolean} waitForCompletion - Whether callers are waiting for task completion (affects retry/flow decisions).
 * @param {function|null} onChunk - Optional streaming chunk callback passed through to retries.
 * @returns {object} An object describing the result:
 *  - On verification detection: { error: string, verification: true, chatId }.
 *  - When a retry is initiated: returns the result of the subsequent sendMessage call.
 *  - When tokens are exhausted or unauthorized: { error: string, chatId }.
 *  - Default fallback: { error: string, details: string, chatId }.
 */
async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk = null) {
    logRaw(JSON.stringify(response));
    logError(`Ошибка при получении ответа: ${response.error || response.statusText}`);
    if (response.errorBody) logDebug(`Тело ответа с ошибкой: ${response.errorBody}`);

    if (response.html && response.html.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');
        await pagePool.clear();
        setAuthToken(null);
        await shutdownBrowser();
        await initBrowser(true);
        return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true, chatId };
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
        setAuthToken(null);
        browserTokenRateLimited = false;
        if (tokenObj?.id && tokenObj.id !== 'browser') {
            const { markInvalid } = await import('./tokenManager.js');
            markInvalid(tokenObj.id);
        }
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk);
        }
        logError('Не осталось валидных токенов или исчерпаны попытки.');
        return { error: 'Все токены недействительны (401). Требуется повторная авторизация.', chatId };
    }

    if (response.status === 429 || (response.errorBody && response.errorBody.includes('RateLimited'))) {
        let hours = 24;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            hours = Number(rateInfo.num) || 24;
        } catch { /* errorBody might not be valid JSON */ }

        if (tokenObj?.id === 'browser') {
            browserTokenRateLimited = true;
            logWarn(`Browser-токен достиг лимита. Помечаем на ${hours}ч.`);
        } else if (tokenObj?.id) {
            markRateLimited(tokenObj.id, hours);
            logWarn(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
        }

        setAuthToken(null);
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk);
        }
        return { error: `Все токены заблокированы по лимиту (${hours}ч)`, chatId };
    }

    return { error: response.error || response.statusText, details: response.errorBody || 'Нет дополнительных деталей', chatId };
}

/**
 * Send a message to the upstream chat API, handling token resolution, browser vs token-only modes, retries, streaming chunks, and task polling.
 *
 * @param {string|Array} message - Message content as a plain string or an array of structured message items (e.g., `{type:'text', text: '...'}`, `{type:'image', image: '...'}`, `{type:'file', file: '...'}`).
 * @param {string} [model=DEFAULT_MODEL] - Model identifier to use for generation.
 * @param {string|null} [chatId=null] - Existing chat ID to send the message into; if omitted a new chat will be created.
 * @param {string|null} [parentId=null] - Parent message ID (reply/threading reference).
 * @param {Array|null} [files=null] - Optional array of file descriptors to attach to the message.
 * @param {Array|null} [tools=null] - Optional tools metadata to include in the payload.
 * @param {string|null} [toolChoice=null] - Tool selection strategy or explicit tool id; defaults to automatic selection when omitted.
 * @param {string|null} [systemMessage=null] - Optional system-level message to include in the request payload.
 * @param {string} [chatType='t2t'] - Chat generation type (`'t2t'` text, `'t2i'` image, `'t2v'` video, etc.).
 * @param {string|null} [size=null] - Optional size parameter for image/video generation.
 * @param {boolean} [waitForCompletion=true] - For task responses (e.g., video generation), whether to poll and wait for completion.
 * @param {number} [retryCount=0] - Internal retry counter used by the function when reattempting transient failures.
 * @param {function|null} [onChunk=null] - Optional callback invoked with streaming content chunks as they arrive (signature: `onChunk(chunkString)`).
 * @returns {Object} On success returns a completion or task object (examples: `{ id, object, created, model, choices, usage, response_id, chatId, parentId }` for normal completions; task responses include `task_id` and may include `video_url`). On failure returns an error object `{ error: <message>, chatId, ... }`.
 */

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    if (!chatId) {
        if (!isBrowserAvailable()) {
            const newChatResult = await createChatV2NodeFetch(model, 'Новый чат', chatType);
            if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
            chatId = newChatResult.chatId;
            logInfo(`Создан новый чат (Node fetch) с ID: ${chatId}`);
        } else {
            const newChatResult = await createChatV2(model, 'Новый чат', 0, chatType);
            if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
            chatId = newChatResult.chatId;
            logInfo(`Создан новый чат v2 с ID: ${chatId}`);
        }
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    const messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    // ─── Token-only path: no browser required ──────────────────────────────
    if (!isBrowserAvailable()) {
        const tokenObj = await getAvailableToken();
        if (!tokenObj?.token) return { error: 'No valid tokens available', chatId };
        setAuthToken(tokenObj.token);
        logInfo(`Token-only mode: using account ${tokenObj.id}`);

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        logDebug('=== TOKEN-ONLY PAYLOAD ===\n' + JSON.stringify(payload, null, 2));

        const response = await executeApiRequestWithNodeStreaming(apiUrl, payload, getAuthToken(), onChunk);

        if (response.success) {
            logInfo('Token-only: response received successfully');
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();

            // Fallback: if no streamed chunks, deliver content as single chunk
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }

            return response.data;
        }

        // Rate limit
        if (response.status === 429) {
            markRateLimited(tokenObj.id);
            logWarn(`Token ${tokenObj.id} rate limited in token-only mode`);
            return { error: 'Rate limited', chatId };
        }

        // Auth failure
        if (response.status === 401) {
            const { markInvalid } = await import('./tokenManager.js');
            markInvalid(tokenObj.id);
            logWarn(`Token ${tokenObj.id} invalid (401) in token-only mode`);
            return { error: 'Unauthorized', chatId };
        }

        return { error: response.error || response.statusText, details: response.errorBody || 'No details', chatId };
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        if (!getAuthToken()) {
            logWarn('Токен отсутствует перед отправкой запроса');
            setAuthToken(await page.evaluate(() => localStorage.getItem('token')));
            if (!getAuthToken()) return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.', chatId };
            saveAuthToken(getAuthToken());
        }

        logInfo('Отправка запроса к API v2...');

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        const response = await executeApiRequest(page, apiUrl, payload, getAuthToken(), onChunk);

        if (response.success && response.isTask) {
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID не найден в ответе', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Задача генерации видео создана. Для прогресса используйте GET /api/tasks/status/:taskId.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(taskId, page, getAuthToken());

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            
            // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }
            
            return response.data;
        }

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: error.toString(), chatId };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function findMediaUrl(value, extensions = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
    if (!value) return null;
    if (typeof value === 'string') {
        const direct = value.match(/https?:\/\/[^\s"'<>]+/g)?.find(url => extensions.some(ext => url.toLowerCase().includes(ext)));
        return direct || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === 'object') {
        const preferredKeys = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];
        for (const key of preferredKeys) {
            if (key in value) {
                const found = findMediaUrl(value[key], extensions);
                if (found) return found;
            }
        }
        for (const item of Object.values(value)) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
    }
    return null;
}

export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? ['.mp4', '.mov', '.webm']
        : type === 'image'
            ? ['.png', '.jpg', '.jpeg', '.webp']
            : ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
    return findMediaUrl(value, extensions);
}

function extractVideoUrl(taskData) {
    return extractMediaUrl(taskData, 'video');
}

export async function pollQwenTaskStatus(taskId, waitForCompletion = false) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', task_id: taskId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj?.token) return { error: 'Ошибка авторизации: не удалось получить токен', task_id: taskId };

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = waitForCompletion
            ? await pollTaskStatus(taskId, page, tokenObj.token)
            : await pollTaskStatus(taskId, page, tokenObj.token, 1, 0);

        const mediaUrl = extractMediaUrl(result.data || result, 'video') || extractMediaUrl(result.data || result, 'image');
        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: extractMediaUrl(result.data || result, 'video'),
            image_url: extractMediaUrl(result.data || result, 'image'),
            media_url: mediaUrl,
            data: result.data
        };
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

/**
 * Clears and closes all pooled browser pages except the base context.
 *
 * Empties the page pool and closes any pages it manages to release resources.
 */
export async function clearPagePool() {
    await pagePool.clear();
}

// Register clearPagePool implementation with sharedState so browser.js can call it
// without importing from chat.js (breaks circular dependency).
registerClearPagePool(async () => { await pagePool.clear(); });

/**
 * Create a new chat on the upstream service using an available API token.
 * @param {string} model - Model identifier to assign to the new chat.
 * @param {string} title - Title for the new chat.
 * @param {string} [chatType='t2t'] - Chat type (e.g., `'t2t'`, `'t2v'`); defaults to `'t2t'`.
 * @return {{success: true, chatId: string}|{error: string}} An object with `{ success: true, chatId }` on success, or `{ error }` on failure.
 */

async function createChatV2NodeFetch(model, title, chatType = 't2t') {
    const tokenObj = await getAvailableToken();
    if (!tokenObj?.token) return { error: 'No valid tokens available' };
    setAuthToken(tokenObj.token);

    const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };

    try {
        const response = await fetch(CREATE_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return { error: `HTTP ${response.status}: ${errorBody}` };
        }

        const result = await response.json();
        if (result.success && result.data?.id) {
            logInfo(`Chat created via Node fetch: ${result.data.id}`);
            return { success: true, chatId: result.data.id };
        }
        return { error: result.error || 'Unknown error creating chat' };
    } catch (err) {
        return { error: err.toString() };
    }
}

/**
 * Create a new chat on the upstream service and return its identifier.
 *
 * Attempts to ensure an authorization token is available (from available accounts or browser storage),
 * sends a create-chat request, and retries transient server errors up to the configured limit.
 *
 * @param {string} [model=DEFAULT_MODEL] - Model identifier to associate with the chat.
 * @param {string} [title='Новый чат'] - Title for the new chat.
 * @param {number} [retryCount=0] - Current retry attempt count (used internally for retries).
 * @param {string} [chatType='t2t'] - Chat type, e.g. `'t2t'` (text-to-text) or `'t2v'` (text-to-video).
 * @returns {{success: true, chatId: string, requestId?: string} | {error: string}}
 *          `{ success: true, chatId, requestId }` on success; otherwise an object with an `error` string describing the failure.
 */

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0, chatType = 't2t') {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован' };

    const tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        setAuthToken(tokenObj.token);
        logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    }

    if (!getAuthToken()) {
        logInfo('Получение токена авторизации для создания чата...');
        setAuthToken(await extractAuthToken(browserContext));
        if (!getAuthToken()) return { error: 'Не удалось получить токен авторизации' };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        const requestBody = { apiUrl: CREATE_CHAT_URL, payload, token: getAuthToken() };

        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, requestBody);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data.success) {
            logInfo(`Чат создан: ${result.data.data.id}`);
            return { success: true, chatId: result.data.data.id, requestId: result.data.request_id };
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType);
        }

        const cleanError = isTransient
            ? `Qwen API недоступен (${result.status}). Повторите позже.`
            : (result.errorBody || result.error || 'Неизвестная ошибка');
        logError(`Ошибка при создании чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return { error: cleanError };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    let shouldClosePage = false;
    try {
        page = await getPage(browserContext);
        shouldClosePage = page !== browserContext;
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const requestBody = {
            apiUrl: CHAT_API_URL,
            token,
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, requestBody);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (shouldClosePage) await page.close(); } catch { }
        }
    }
}
