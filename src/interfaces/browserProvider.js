// ===== BROWSER PROVIDER INTERFACE =====
// Interface definition + registry for browser providers.
// Phase 3 will create concrete implementations (PuppeteerProvider,
// PlaywrightProvider, etc.) that call registerBrowserProvider() at import time.
// This module has no external dependencies — pure JS interface contract.

/**
 * @typedef {Object} BrowserProvider
 * @property {string} name - Unique identifier for this provider
 * @property {() => Promise<Page|null>} getPage - Acquire a browser page for automation
 * @property {() => BrowserContext|null} getContext - Get the current browser context
 * @property {() => boolean} isAvailable - Check if this provider can be used in the current environment
 * @property {() => Promise<void>} shutdown - Gracefully shut down the browser
 */

const providers = new Map();

/**
 * Register a browser provider.
 * @param {BrowserProvider} provider
 */
export function registerBrowserProvider(provider) {
    if (!provider.name || typeof provider.name !== 'string') {
        throw new Error('BrowserProvider must have a non-empty string name');
    }
    if (typeof provider.getPage !== 'function') {
        throw new Error('BrowserProvider must implement getPage()');
    }
    if (typeof provider.isAvailable !== 'function') {
        throw new Error('BrowserProvider must implement isAvailable()');
    }
    if (typeof provider.shutdown !== 'function') {
        throw new Error('BrowserProvider must implement shutdown()');
    }
    providers.set(provider.name, provider);
}

/**
 * Get a registered browser provider by name.
 * @param {string} name
 * @returns {BrowserProvider|undefined}
 */
export function getBrowserProvider(name) {
    return providers.get(name);
}

/**
 * List all registered provider names.
 * @returns {string[]}
 */
export function getAvailableProviders() {
    return Array.from(providers.keys());
}
