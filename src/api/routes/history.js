// Chat history save/load routes

import express from 'express';
import { loadHistory, saveHistory } from '../chatHistory.js';
import { logInfo, logError } from '../../logger/index.js';

const router = express.Router();

// Эндпоинт для сохранения истории чата (для работы с Open WebUI)
router.post('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { messages } = req.body;

        logInfo(`Запрос сохранения истории для чата: ${chatId}`);

        if (!messages || !Array.isArray(messages)) {
            logError('История сообщений не указана или некорректна');
            return res.status(400).json({ error: 'История сообщений должна быть массивом' });
        }

        // Сохраняем историю через saveHistory
        const saveResult = await saveHistory(chatId, messages);
        if (!saveResult) {
            logError(`Не удалось сохранить историю для чата ${chatId}`);
            return res.status(500).json({ error: 'Не удалось сохранить историю' });
        }

        res.json({
            success: true,
            chatId: chatId,
            messagesCount: messages.length
        });
    } catch (error) {
        logError('Ошибка при сохранении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения истории чата (для работы с Open WebUI)
router.get('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;

        logInfo(`Запрос истории для чата: ${chatId}`);

        // Загружаем историю через loadHistory
        const messages = await loadHistory(chatId);

        res.json({
            success: true,
            chatId: chatId,
            messages: messages || []
        });
    } catch (error) {
        logError('Ошибка при получении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;
