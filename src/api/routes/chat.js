// Chat route handlers — POST /chat, POST /chat/completions (unified), POST /chats, GET /chat/completions (405)
// Per D-04 (CLNT-02): single POST /chat/completions handler — /v1/chat/completions is handled
// by URL normalization in the central router, so both paths reach this handler.

import express from 'express';
import crypto from 'crypto';
import { sendMessage, createChatV2 } from '../chat.js';
import { logInfo, logError, logDebug } from '../../logger/index.js';
import { getMappedModel } from '../modelMapping.js';
import { DEFAULT_MODEL, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from '../../config.js';
import { setSseHeaders, writeSseChunk, sendSseDone, buildChunk, sendSseError } from '../helpers/streaming.js';
import { buildCombinedTools, prepareOpenAIMessageInput, applyToolPrompt, parseToolCallJson, buildOpenAIToolResponse, writeToolCallsSse } from '../helpers/toolCalls.js';
import { isOpenWebUiMetaRequest, normalizeIdValue, parseOpenAIMessages, shouldForceNewChat } from '../helpers/messageParsing.js';
import { extractConversationHint, extractParentHint } from '../helpers/messageParsing.js';
import { generateChatIdFromHistory, buildInternalChatIdFromHint, mapChatId, resolveQwenChatId } from '../helpers/chatId.js';
import { getSavedChatId, saveChatIdForSession, shouldPersistSessionContext } from '../helpers/sessions.js';
import { loadHistory, saveHistory } from '../chatHistory.js';

const router = express.Router();

// ─── POST /chat — Legacy Qwen-format chat endpoint ──────────────────────────

router.post('/chat', async (req, res) => {
    try {
        const { message, messages, model, chatId, parentId, stream, chatType, size, waitForCompletion } = req.body;

        // Поддержка как message, так и messages для совместимости
        let messageContent = message;
        let systemMessage = null;
        let allMessages = messages; // Сохраняем всю историю
        const isMeta = isOpenWebUiMetaRequest(messages);

        if (messages && Array.isArray(messages)) {
            const parsed = parseOpenAIMessages(messages);
            systemMessage = parsed.systemMessage;
            if (parsed.messageContent) messageContent = parsed.messageContent;
        }

        if (!messageContent) {
            logError('Запрос без сообщения');
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        logInfo(`Получен запрос: ${typeof messageContent === 'string' ? messageContent.substring(0, 50) + (messageContent.length > 50 ? '...' : '') : 'Составное сообщение'}`);
        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }
        if (chatId && !isMeta) {
            logInfo(`Используется chatId: ${chatId}, parentId: ${parentId || 'null'}`);
        } else if (isMeta) {
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }
        if (allMessages && allMessages.length > 1) {
            logInfo(`История содержит ${allMessages.length} сообщений`);
        }

        let mappedModel = model || "qwen-max-latest";
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
        }
        logInfo(`Используется модель: ${mappedModel}`);

        // Поддержка стриминга для OpenWebUI
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            // Важно для OpenWebUI - не кэшировать
            res.setHeader('X-Accel-Buffering', 'no');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                // Setup streaming callback
                let streamingCallback = null;
                let hasStreamedChunks = false;
                if (stream) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    isMeta ? null : chatId,
                    isMeta ? null : parentId,
                    null,
                    null,
                    null,
                    systemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Чанки уже были отправлены через streamingCallback, не дублируем!

                // Финальный чанк
                writeSse({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
        }

            const result = await sendMessage(messageContent, mappedModel, isMeta ? null : chatId, isMeta ? null : parentId, null, null, null, systemMessage, chatType || 't2t', size || null, waitForCompletion ?? true);

        if (result.choices && result.choices[0] && result.choices[0].message) {
            const responseLength = result.choices[0].message.content ? result.choices[0].message.content.length : 0;
            logInfo(`Ответ успешно сформирован для запроса, длина ответа: ${responseLength}`);
            
            // Сохраняем историю чата
            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const updatedMessages = allMessages || [
                        { role: 'user', content: messageContent },
                        { role: 'assistant', content: result.choices[0].message.content }
                    ];
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }
        } else if (result.error) {
            logInfo(`Получена ошибка в ответе: ${result.error}`);
        }

        res.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ─── GET /chat/completions — 405 Method Not Allowed ─────────────────────────

router.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

// ─── POST /chats — Create new chat ──────────────────────────────────────────

router.post('/chats', async (req, res) => {
    try {
        const { name, model } = req.body;
        const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        const result = await createChatV2(chatModel, name || 'Новый чат');
        if (result.error) { logError(`Ошибка создания чата: ${result.error}`); return res.status(500).json({ error: result.error }); }
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ─── POST /chat/completions — Unified OpenAI-compatible completion handler ──
// Per D-04 (CLNT-02): this single handler serves both /chat/completions and
// /v1/chat/completions (URL normalization in central router strips the /v1/ prefix).
// The handler merges ALL behavior from both original handlers (Pitfall 5):
//   - Saves history in non-streaming mode (from v1 handler)
//   - Includes x_qwen_* response headers in non-streaming response (from v1 handler)
//   - Calls mapChatId() in streaming path (from non-v1 handler)
//   - Calls saveChatIdForSession() with correct scope (from both)

router.post('/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint ? `conversation:${conversationHint}` : null;
        const forceNewChat = shouldForceNewChat(req);
        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        // Используем переданный chatId ИЛИ восстанавливаем из сессии
        let effectiveChatId = explicitChatId;
        let effectiveParentId = explicitParentId;

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                const savedSession = forceNewChat ? null : getSavedChatId(req);
                if (savedSession?.chatId) {
                    effectiveChatId = savedSession.chatId;
                    if (!effectiveParentId && savedSession.parentId) {
                        effectiveParentId = savedSession.parentId;
                    }
                    logInfo(`Restored chatId from session: ${effectiveChatId}`);
                }

                if (!effectiveChatId) {
                    const generatedId = generateChatIdFromHistory(messages);
                    if (generatedId) {
                        effectiveChatId = generatedId;
                        logInfo(`Created new chatId for session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        let messageContent = preparedInput.messageContent;
        
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
        
        const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : "qwen-max-latest";
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);
        if (systemMessage) logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);

        const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas; эмулируем через JSON prompt ниже.
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);

        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        // Логируем полную историю сообщений
        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            setSseHeaders(res);

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

                // Setup streaming callback if stream=true
                let streamingCallback = null;
                let hasStreamedChunks = false;
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse(buildChunk(mappedModel, { content: chunk }));
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files, // ← ПЕРЕДАЁМ FILES
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls);
                        return;
                    }
                }

                // Сохраняем chatId в сессию для следующих запросов
                // Per Pitfall 5: includes mapChatId() from non-v1 handler
                if (!isMeta && result.chatId) {
                    // Если мы использовали сгенерированный effectiveChatId — сохраните маппинг
                    if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                        mapChatId(effectiveChatId, result.chatId);
                        logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                    }
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error) {
                    writeSse(buildChunk(mappedModel, { content: `Ошибка: ${result.error}` }));
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse(buildChunk(mappedModel, { content }));
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Чанки уже были отправлены через streamingCallback, не дублируем!

                writeSse(buildChunk(mappedModel, {}, 'stop'));
                sendSseDone(res);

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                sendSseError(res, mappedModel, 'Internal server error');
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);
            const result = await sendMessage(messageContent, mappedModel, qwenChatId, effectiveParentId, files, qwenTools, tool_choice, toolAwareSystemMessage);

            // Сохраняем chatId в сессию для следующих запросов
            if (!isMeta && result.chatId) {
                if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                    mapChatId(effectiveChatId, result.chatId);
                    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                }
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            // Извлекаем контент сообщения (per Pitfall 5: from v1 handler — handles both content locations)
            let messageText = '';
            if (result.choices && result.choices[0] && result.choices[0].message) {
                messageText = result.choices[0].message.content || '';
            } else if (result.response && result.response.text) {
                messageText = result.response.text;
            }

            const toolCalls = parseToolCallJson(messageText);
            if (toolCalls && toolCalls.length > 0) {
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || "qwen-max-latest",
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: messageText
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                // Передаём метаданные для сохранения контекста (per Pitfall 5: from v1 handler)
                x_qwen_chat_id: result.chatId,
                x_qwen_parent_id: result.parentId || result.response_id
            };

            // Сохраняем историю чата (per Pitfall 5: from v1 handler — always save in non-streaming)
            if (result.chatId) {
                // Сохраняем chatId в сессии для последующих запросов от этого клиента
                if (!isMeta) {
                    try {
                        if (shouldPersistSessionContext(conversationScope)) {
                            saveChatIdForSession(req, result.chatId, result.parentId || result.response_id, conversationScope);
                        }
                    } catch (e) {
                        logDebug(`Не удалось сохранить chatId в сессии: ${e.message}`);
                    }
                }

                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: messageText
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

export default router;
