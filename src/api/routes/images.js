// Image generation routes + image model/status helpers

import express from 'express';
import { sendMessage, extractMediaUrl } from '../chat.js';
import { generateImage, getAvailableImageModels, checkImageApiAvailability } from '../imageGeneration.js';
import { getMappedModel } from '../modelMapping.js';
import { listTokens } from '../tokenManager.js';
import { logInfo, logError, logDebug } from '../../logger/index.js';
import { FORGETMEAI_WATERMARK } from '../../utils/branding.js';

const router = express.Router();

// ─── Local helpers (stay in this module per PATTERNS.md) ─────────────────────

const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

/**
 * Resolve an OpenAI-style aspect ratio from common size inputs.
 *
 * Accepts pixel-dimension strings like `1024x1792` (mapped to `9:16`), aspect-ratio strings in the form `A:B` (returned unchanged), or returns `fallback` when `size` is missing or not recognized.
 * @param {string|number|undefined} size - Input size as a pixel-dimension (e.g., `1024x1024`) or an aspect-ratio (`"16:9"`). If falsy, the `fallback` is returned.
 * @param {string} [fallback='16:9'] - Default aspect ratio to use when `size` is missing or cannot be mapped.
 * @returns {string} An `A:B` aspect ratio string derived from `size`, or the `fallback` if no valid mapping exists.
 */
function normalizeQwenAspectRatio(size, fallback = '16:9') {
    if (!size) return fallback;
    const value = String(size).trim();
    const ratioMap = {
        '1024x1024': '1:1',
        '512x512': '1:1',
        '768x768': '1:1',
        '960x960': '1:1',
        '1024x1792': '9:16',
        '1792x1024': '16:9',
        '1536x864': '16:9',
        '864x1536': '9:16'
    };
    if (ratioMap[value]) return ratioMap[value];
    if (/^\d+:\d+$/.test(value)) return value;
    return fallback;
}

/**
 * Convert a WIDTHxHEIGHT size string into DashScope's WIDTH*HEIGHT format.
 * @param {string} size - Size in `WIDTHxHEIGHT` form (e.g., `1024x1024`).
 * @returns {string} The corresponding `WIDTH*HEIGHT` string for DashScope, or `'1024*1024'` if the input is not recognized.
 */
function normalizeDashScopeSize(size) {
    const sizeMap = {
        '1024x1024': '1024*1024',
        '1024x1792': '1024*1792',
        '1792x1024': '1792*1024',
        '512x512': '512*512',
        '768x768': '768*768',
        '960x960': '960*960'
    };
    return sizeMap[size] || '1024*1024';
}

/**
 * Builds a normalized OpenAI-like image generation response object.
 * @param {Object} params
 * @param {string|null} params.imageUrl - The generated image URL or `null` if unavailable.
 * @param {string} params.prompt - Original prompt used to generate the image.
 * @param {string} params.model - Model identifier that produced the image.
 * @param {any} params.raw - Raw response from the image provider (passed through).
 * @param {string} [params.provider='qwen-chat'] - Provider identifier (e.g., `"qwen-chat"` or `"dashscope"`).
 * @returns {Object} Response object with `created` (UNIX seconds), `watermark`, `provider`, `model`, `data` (array with `url` and `revised_prompt`), and `raw`.
 */
function buildOpenAiImageResponse({ imageUrl, prompt, model, raw, provider = 'qwen-chat' }) {
    return {
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider,
        model,
        data: [{ url: imageUrl, revised_prompt: prompt }],
        raw
    };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/images/generations
 * По умолчанию генерирует изображения через Qwen Chat (`chatType: t2i`).
 * Для старого DashScope-режима передайте `provider: "dashscope"`.
 */
router.post('/images/generations', async (req, res) => {
    try {
        const { prompt, model, n, size, response_format, provider } = req.body;

        logInfo('Получен запрос на генерацию изображения');
        logDebug(`Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        if (provider === 'dashscope') {
            const apiKey = process.env.DASHSCOPE_API_KEY;
            if (!apiKey) {
                return res.status(503).json({
                    error: 'DashScope API генерации изображений не настроен',
                    message: 'Установите переменную окружения DASHSCOPE_API_KEY или используйте provider=qwen-chat'
                });
            }

            let imageModel = model || 'qwen-image-plus';
            if (imageModel === 'dall-e-3' || imageModel === 'dall-e-2') imageModel = 'qwen-image-plus';
            const result = await generateImage(prompt, imageModel, {
                n: n || 1,
                size: normalizeDashScopeSize(size),
                promptExtend: true,
                watermark: false
            });

            if (result.error) {
                logError(`Ошибка генерации DashScope: ${result.error}`);
                return res.status(500).json({ error: 'Ошибка генерации изображения', message: result.error });
            }

            return res.json(buildOpenAiImageResponse({
                imageUrl: result.imageUrl,
                prompt,
                model: imageModel,
                raw: result,
                provider: 'dashscope'
            }));
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2i',
            aspectRatio,
            true
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat image: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации изображения через Qwen Chat', message: result.error, details: result.details });
        }

        const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
        if (!imageUrl) {
            return res.status(502).json({
                error: 'Qwen Chat не вернул URL изображения',
                raw: result
            });
        }

        logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
        return res.json(buildOpenAiImageResponse({ imageUrl, prompt, model: chatModel, raw: result }));
    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/images/models - модели для генерации изображений.
 */
router.get('/images/models', async (req, res) => {
    try {
        const dashScopeModels = getAvailableImageModels();
        res.json({
            object: 'list',
            watermark: FORGETMEAI_WATERMARK,
            data: [
                {
                    id: CHAT_MEDIA_MODEL,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen-chat',
                    permission: [],
                    capability: 'qwen_chat_image_generation',
                    provider: 'qwen-chat'
                },
                ...dashScopeModels.map(model => ({
                    id: model,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen',
                    permission: [],
                    capability: 'image_generation',
                    provider: 'dashscope'
                }))
            ]
        });
    } catch (error) {
        logError('Ошибка при получении списка моделей изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * GET /api/images/status - Проверка статуса генерации изображений.
 */
router.get('/images/status', async (req, res) => {
    try {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        const dashScopeAvailable = await checkImageApiAvailability();
        const tokens = listTokens();
        const now = Date.now();
        const qwenChatAvailable = tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);

        res.json({
            watermark: FORGETMEAI_WATERMARK,
            qwenChat: {
                available: qwenChatAvailable,
                model: CHAT_MEDIA_MODEL,
                message: qwenChatAvailable ? 'Qwen Chat генерация изображений доступна' : 'Нет активных аккаунтов Qwen Chat'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: !!apiKey,
                message: dashScopeAvailable
                    ? 'DashScope API генерации изображений доступен'
                    : apiKey
                        ? 'DashScope API недоступен или неверные учётные данные'
                        : 'DASHSCOPE_API_KEY не настроен'
            }
        });
    } catch (error) {
        logError('Ошибка при проверке статуса API изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;
