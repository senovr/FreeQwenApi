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
 * Register an authentication strategy in the in-memory registry.
 *
 * Validates that `strategy.name` is a non-empty string and that
 * `strategy.authenticate` is a function, then stores the strategy under
 * its `name` (overwriting any existing entry with the same name).
 *
 * @param {AuthStrategy} strategy - Strategy to register; must include a non-empty string `name` and an `authenticate` function.
 * @throws {Error} If `strategy.name` is missing or not a non-empty string: "AuthStrategy must have a non-empty string name".
 * @throws {Error} If `strategy.authenticate` is not a function: "AuthStrategy must implement authenticate()".
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
 * Retrieve a registered auth strategy by name.
 * @param {string} name - The unique strategy name.
 * @returns {AuthStrategy|undefined} `AuthStrategy` if a strategy with the given name is registered, `undefined` otherwise.
 */
export function getAuthStrategy(name) {
    return strategies.get(name);
}

/**
 * List all registered authentication strategy names.
 * @returns {string[]} Array of registered strategy names.
 */
export function getAvailableStrategies() {
    return Array.from(strategies.keys());
}
