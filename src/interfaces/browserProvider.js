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
 * Register a BrowserProvider implementation under its declared name.
 *
 * Validates that `provider.name` is a non-empty string and that `getPage`, `getContext`, `isAvailable`,
 * and `shutdown` are functions. On success, stores or overwrites the provider in the internal registry keyed by `provider.name`.
 *
 * @param {BrowserProvider} provider - Implementation matching the `BrowserProvider` typedef; must include `name`, `getPage`, `getContext`, `isAvailable`, and `shutdown`.
 * @throws {Error} If `provider.name` is missing or not a non-empty string (message: "BrowserProvider must have a non-empty string name").
 * @throws {Error} If `provider.getPage` is not a function (message: "BrowserProvider must implement getPage()").
 * @throws {Error} If `provider.getContext` is not a function (message: "BrowserProvider must implement getContext()").
 * @throws {Error} If `provider.isAvailable` is not a function (message: "BrowserProvider must implement isAvailable()").
 * @throws {Error} If `provider.shutdown` is not a function (message: "BrowserProvider must implement shutdown()").
 */
export function registerBrowserProvider(provider) {
    if (!provider.name || typeof provider.name !== 'string') {
        throw new Error('BrowserProvider must have a non-empty string name');
    }
    if (typeof provider.getPage !== 'function') {
        throw new Error('BrowserProvider must implement getPage()');
    }
    if (typeof provider.getContext !== 'function') {
        throw new Error('BrowserProvider must implement getContext()');
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
 * Retrieve a registered browser provider by its name.
 * @param {string} name - The provider's unique name.
 * @returns {BrowserProvider|undefined} `BrowserProvider` if found, `undefined` otherwise.
 */
export function getBrowserProvider(name) {
    return providers.get(name);
}

/**
 * Return the names of all providers currently registered in the in-memory registry.
 * @returns {string[]} An array of registered provider names.
 */
export function getAvailableProviders() {
    return Array.from(providers.keys());
}
