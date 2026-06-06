// scripts/postinstall.js — Conditional Chrome install based on platform matrix.
// Runs during npm install. Installs Chrome only on supported platforms.
// ALWAYS exits 0 — never blocks npm install.

import { detectBrowserPlatform } from '@puppeteer/browsers';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statusFile = path.join(__dirname, '..', '.chrome-status');

// Platforms where Chrome download is available via Puppeteer
const INSTALL_PLATFORMS = ['linux', 'mac', 'mac_arm', 'win64'];

try {
    const platform = detectBrowserPlatform();

    if (!platform || !INSTALL_PLATFORMS.includes(platform)) {
        const data = {
            installed: false,
            platform: platform || 'unknown',
            reason: 'unsupported',
            date: new Date().toISOString()
        };
        fs.writeFileSync(statusFile, JSON.stringify(data, null, 2));
        console.log(`Skipped: no Chrome binary for ${platform || 'unknown platform'}. Proxy will run in browser-free mode.`);
        process.exit(0);
    }

    console.log(`Installing Chrome for ${platform}...`);
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit', timeout: 120_000 });

    const data = {
        installed: true,
        platform,
        date: new Date().toISOString()
    };
    fs.writeFileSync(statusFile, JSON.stringify(data, null, 2));
    console.log('Chrome installed successfully.');
} catch (err) {
    const data = {
        installed: false,
        error: err.message,
        date: new Date().toISOString()
    };
    try { fs.writeFileSync(statusFile, JSON.stringify(data, null, 2)); } catch {}
    console.log(`Chrome install failed: ${err.message}. Proxy will run in browser-free mode.`);
}

process.exit(0);
