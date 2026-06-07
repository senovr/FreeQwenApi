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

        // Здесь можно добавить логику сохранения истории
        // Для теперь просто подтверждаем сохранение
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

        // Здесь можно добавить логику получения истории из БД
        // Для теперь возвращаем пустую историю
        res.json({
            success: true,
            chatId: chatId,
            messages: []
        });
    } catch (error) {
        logError('Ошибка при получении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;
