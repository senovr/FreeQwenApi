// Video generation routes + video model/status helpers

import express from 'express';
import { sendMessage, extractMediaUrl } from '../chat.js';
import { getMappedModel } from '../modelMapping.js';
import { listTokens } from '../tokenManager.js';
import { logInfo, logError, logDebug } from '../../logger/index.js';
import { FORGETMEAI_WATERMARK } from '../../utils/branding.js';

const router = express.Router();

// ─── Local helpers (stay in this module per PATTERNS.md) ─────────────────────

const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

/**
 * Convert a requested size string into a Qwen-compatible aspect ratio.
 *
 * @param {string|number|undefined} size - Requested size (e.g., "1024x1792" or "3:2"); may be falsy.
 * @param {string} [fallback='16:9'] - Aspect ratio to return when `size` is falsy or unrecognized.
 * @returns {string} The resolved aspect ratio (e.g., "16:9", "9:16", "1:1") or the provided fallback.
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
 * Build a standardized response payload for a completed video or an in-progress video generation task.
 *
 * @param {Object} params
 * @param {Object} params.result - Raw provider result object; may contain `video_url`, `task_id`, `id`, and `status`.
 * @param {string} params.prompt - The user prompt that initiated the generation.
 * @param {string} params.model - The model identifier used for generation.
 * @param {boolean} params.waitForCompletion - Whether the request waited for generation completion.
 * @returns {Object} A response object containing id, object type (`video.generation` or `video.generation.task`), creation timestamp, watermark, provider, model, prompt, status, task_id, video_url, data array (with video URL when available), waitForCompletion flag, and the raw provider result under `raw`.
 */
function buildVideoResponse({ result, prompt, model, waitForCompletion }) {
    const videoUrl = result.video_url || extractMediaUrl(result, 'video');
    return {
        id: result.id || result.task_id || `video-${Date.now()}`,
        object: videoUrl ? 'video.generation' : 'video.generation.task',
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider: 'qwen-chat',
        model,
        prompt,
        status: videoUrl ? 'completed' : (result.status || 'processing'),
        task_id: result.task_id || result.id || null,
        video_url: videoUrl || null,
        data: videoUrl ? [{ url: videoUrl }] : [],
        waitForCompletion,
        raw: result
    };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/videos/generations - Генерация видео через Qwen Chat (`chatType: t2v`).
 */
router.post('/videos/generations', async (req, res) => {
    try {
        const { prompt, model, size, wait, waitForCompletion } = req.body;
        const shouldWait = waitForCompletion ?? wait ?? true;

        logInfo('Получен запрос на генерацию видео через Qwen Chat');
        logDebug(`Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
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
            't2v',
            aspectRatio,
            shouldWait
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat video: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации видео через Qwen Chat', message: result.error, details: result.details, task_id: result.task_id });
        }

        const response = buildVideoResponse({ result, prompt, model: chatModel, waitForCompletion: shouldWait });
        logInfo(response.video_url ? `Видео Qwen Chat сгенерировано: ${response.video_url}` : `Видео-задача создана: ${response.task_id}`);
        return res.json(response);
    } catch (error) {
        logError('Ошибка при генерации видео', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/videos/models - модели для генерации видео через Qwen Chat.
 */
router.get('/videos/models', async (req, res) => {
    res.json({
        object: 'list',
        watermark: FORGETMEAI_WATERMARK,
        data: [{
            id: CHAT_MEDIA_MODEL,
            object: 'model',
            created: Date.now(),
            owned_by: 'qwen-chat',
            permission: [],
            capability: 'qwen_chat_video_generation',
            provider: 'qwen-chat'
        }]
    });
});

/**
 * GET /api/videos/status - Проверка готовности видео-генерации Qwen Chat.
 */
router.get('/videos/status', async (req, res) => {
    const tokens = listTokens();
    const now = Date.now();
    const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;
    res.json({
        watermark: FORGETMEAI_WATERMARK,
        available: availableAccounts > 0,
        model: CHAT_MEDIA_MODEL,
        accounts: { total: tokens.length, available: availableAccounts },
        message: availableAccounts > 0 ? 'Qwen Chat генерация видео доступна' : 'Нет активных аккаунтов Qwen Chat'
    });
});

export default router;
