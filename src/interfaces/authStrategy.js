// ===== AUTH STRATEGY INTERFACE =====
// Interface definition + registry for authentication strategies.
// Phase 3 will create concrete implementations (PuppeteerAuthStrategy,
// QrLinkAuthStrategy, etc.) that call registerAuthStrategy() at import time.
// This module has no external dependencies — pure JS interface contract.

/**
 * @typedef {Object} AuthStrategy
 * @property {string} name - Unique identifier for this strategy
 * @property {() => Promise<string|null>} authenticate - Perform authentication, return token or null
 * @property {(token: string) => Promise<string|null>} refreshToken - Refresh an expired token, return new token or null
 * @property {() => boolean} isAvailable - Check if this strategy can be used in the current environment
 */

const strategies = new Map();

/**
 * Register an authentication strategy.
 * @param {AuthStrategy} strategy
 */
export function registerAuthStrategy(strategy) {
    if (!strategy.name || typeof strategy.name !== 'string') {
        throw new Error('AuthStrategy must have a non-empty string name');
    }
    if (typeof strategy.authenticate !== 'function') {
        throw new Error('AuthStrategy must implement authenticate()');
    }
    strategies.set(strategy.name, strategy);
}

/**
 * Get a registered auth strategy by name.
 * @param {string} name
 * @returns {AuthStrategy|undefined}
 */
export function getAuthStrategy(name) {
    return strategies.get(name);
}

/**
 * List all registered strategy names.
 * @returns {string[]}
 */
export function getAvailableStrategies() {
    return Array.from(strategies.keys());
}
