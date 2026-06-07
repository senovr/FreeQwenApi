// Async task polling route

import express from 'express';
import { pollQwenTaskStatus } from '../chat.js';
import { logError } from '../../logger/index.js';
import { FORGETMEAI_WATERMARK } from '../../utils/branding.js';

const router = express.Router();

/**
 * GET /api/tasks/status/:taskId - статус долгой задачи Qwen Chat (видео и будущие async-функции).
 */
router.get('/tasks/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        if (!taskId) return res.status(400).json({ error: 'taskId обязателен' });

        const result = await pollQwenTaskStatus(taskId, wait);
        if (result.error && !result.data) {
            return res.status(500).json(result);
        }
        return res.json({ watermark: FORGETMEAI_WATERMARK, ...result });
    } catch (error) {
        logError('Ошибка при проверке статуса задачи', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

export default router;
