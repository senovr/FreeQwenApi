// Central router — imports all domain routers, applies auth + URL normalization middleware
// Replaces the former routes.js monolith (per D-03, ARCH-03)

import express from 'express';
import { authMiddleware } from '../helpers/auth.js';
import chatRoutes from './chat.js';
import imageRoutes from './images.js';
import videoRoutes from './videos.js';
import fileRoutes from './files.js';
import historyRoutes from './history.js';
import statusRoutes from './status.js';
import taskRoutes from './tasks.js';

const router = express.Router();

// Auth middleware — applies to ALL routes (security: must be first)
router.use(authMiddleware);

// URL normalization: strip /v1/ and /v2/ prefixes (per D-04, CLNT-02)
router.use((req, res, next) => {
    req.url = req.url.replace(/\/v[12](?=\/|$)/g, '').replace(/\/+/g, '/');
    next();
});

// Mount domain routers
router.use(chatRoutes);
router.use(imageRoutes);
router.use(videoRoutes);
router.use(fileRoutes);
router.use(historyRoutes);
router.use(statusRoutes);
router.use(taskRoutes);

export default router;
