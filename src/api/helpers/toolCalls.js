// Hermes tool call adapter functions (per D-08, CLNT-03)
// Extracted verbatim from routes.js

import crypto from 'crypto';

/**
 * Normalize provided tools or functions into a combined tool list and return it alongside the chosen tool identifier.
 * @param {?Array<Object>} tools - Explicit tool descriptors; used as-is when provided.
 * @param {?Array<Object>} functions - List of function descriptors to convert into tool descriptors when `tools` is not provided. Each entry will be mapped to an object of the form `{ type: 'function', function: fn }`.
 * @param {?string} toolChoice - An opaque identifier indicating the selected tool (passed through to the return value).
 * @returns {{ combinedTools: Array<Object>|null, toolChoice: ?string }} An object containing `combinedTools` (the `tools` array if given, otherwise the mapped `functions` array, or `null` if neither was provided) and the original `toolChoice`. 
 */
export function buildCombinedTools(tools, functions, toolChoice) {
    const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
    return { combinedTools, toolChoice };
}

/**
 * Convert OpenAI-style message content into a single plain string.
 *
 * Handles null/undefined, plain strings, arrays of mixed content objects (text, image, image_url, file), and other values by stringifying them.
 * @param {*} content - Message content which may be a string, an array of parts (each part can be a string or an object with `type` like `'text'`, `'image'`, `'image_url'`, or `'file'`), or any other value.
 * @returns {string} A single string representation of the content; empty string for null/undefined, joined lines for arrays, or JSON string for other non-string values.
 */
export function stringifyOpenAIContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return `[image: ${item.image_url?.url || ''}]`;
            if (item.type === 'image') return `[image: ${item.image || ''}]`;
            if (item.type === 'file') return `[file: ${item.file || item.name || ''}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join('\n');
    }
    return JSON.stringify(content);
}

/**
 * Builds a single folded transcript string from an array of OpenAI-style messages.
 *
 * Processes each message (ignoring falsy values and messages with role "system") and appends
 * human-readable entries describing the role and its content:
 * - User messages are rendered as "User: <content>"
 * - Assistant messages are rendered as "Assistant: <content>" and, if present, an additional
 *   "Assistant tool calls: <JSON tool_calls>" line is appended
 * - Tool messages are rendered as "Tool result (<name>): <content>" where <name> is taken from
 *   the message's `name`, `tool_call_id`, or defaults to "tool"
 * - Other roles are rendered as "<role>: <content>"
 *
 * Message content is converted to a concise string representation before inclusion. The returned
 * transcript contains the individual entries separated by blank lines.
 *
 * @param {Array<Object>} messages - Array of OpenAI-style message objects to fold into a transcript.
 * @returns {string} The folded transcript as a string (empty string if no applicable messages).
 */
export function buildStatelessTranscript(messages) {
    const parts = [];
    for (const msg of messages || []) {
        if (!msg || msg.role === 'system') continue;
        if (msg.role === 'user') {
            parts.push(`User: ${stringifyOpenAIContent(msg.content)}`);
        } else if (msg.role === 'assistant') {
            const text = stringifyOpenAIContent(msg.content);
            if (text) parts.push(`Assistant: ${text}`);
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                parts.push(`Assistant tool calls: ${JSON.stringify(msg.tool_calls)}`);
            }
        } else if (msg.role === 'tool') {
            const name = msg.name || msg.tool_call_id || 'tool';
            parts.push(`Tool result (${name}): ${stringifyOpenAIContent(msg.content)}`);
        } else {
            parts.push(`${msg.role || 'message'}: ${stringifyOpenAIContent(msg.content)}`);
        }
    }
    return parts.join('\n\n');
}


/**
 * Detects whether a list of messages contains OpenAI tool-related state.
 * @param {Array<Object>} messages - Chat messages to inspect; each message may include `role`, `tool_calls`, or `function_call`.
 * @returns {boolean} `true` if any message has `role` of `"tool"` or `"function"`, or if an `"assistant"` message contains non-empty `tool_calls` or a `function_call`, `false` otherwise.
 */
export function hasOpenAIToolState(messages) {
    return (messages || []).some(msg =>
        msg?.role === 'tool' ||
        msg?.role === 'function' ||
        (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
        (msg?.role === 'assistant' && msg.function_call)
    );
}

/**
 * Decide whether the OpenAI-style message history should be folded into a single prompt.
 *
 * Determines folding based on message content and context: it will fold when the history
 * contains OpenAI tool-related state, when there is no effective chat id and multiple
 * non-system messages exist, or when tools are available and there are multiple
 * non-system messages.
 *
 * @param {Array<Object>} messages - Array of chat messages (may include system/user/assistant/tool roles).
 * @param {Array|Null} combinedTools - Combined tool descriptors (array when tools are available, otherwise null).
 * @param {string|Null} effectiveChatId - The effective conversation/chat id, or null/undefined when absent.
 * @returns {boolean} `true` if the transcript should be folded into a single prompt, `false` otherwise.
 */
export function shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId) {
    const nonSystemMessages = (messages || []).filter(msg => msg && msg.role !== 'system');
    if (nonSystemMessages.length === 0) return false;

    // Hermes/OpenAI agents send the full state every request. After a tool call the
    // next request often ends with role=tool, not role=user. Qwen Chat has no native
    // OpenAI tool-result role, so preserving context means folding the whole OpenAI
    // transcript into a single user message for that turn.
    if (hasOpenAIToolState(messages)) return true;

    // If FreeQwenApi is used as a stateless OpenAI-compatible endpoint and no
    // conversation id/chat id was provided, keep the complete client-side history.
    if (!effectiveChatId && nonSystemMessages.length > 1) return true;

    // When tools are available, prefer the OpenAI transcript over Qwen's opaque web
    // chat memory on multi-message turns. This keeps Hermes skill/tool discipline in
    // the prompt visible to Qwen instead of depending on previous web-chat state.
    if (Array.isArray(combinedTools) && combinedTools.length > 0 && nonSystemMessages.length > 1) return true;

    return false;
}

/**
 * Determine the message payload to send to OpenAI by either folding the transcript or using the last user message.
 *
 * @param {Array<Object>} messages - Chat messages in chronological order; each message may have `role`, `content`, and `files`.
 * @param {Array|Null} combinedTools - Combined tool descriptors (used to decide whether folding is necessary).
 * @param {string|undefined|null} effectiveChatId - The chat identifier used to decide whether folding is necessary.
 * @returns {{messageContent: string|null, files: Array, folded: boolean, missingUser: boolean}}
 *   An object containing:
 *   - `messageContent`: the string to send as the user message or folded transcript, or `null` if no user message exists.
 *   - `files`: files associated with the selected user message (empty array when none).
 *   - `folded`: `true` if the transcript was folded into a stateless prompt, `false` otherwise.
 *   - `missingUser`: `true` when no user message was found, `false` otherwise.
 */
export function prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId) {
    const lastUserMessage = (messages || []).filter(msg => msg && msg.role === 'user').pop();
    if (shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId)) {
        return {
            messageContent: buildStatelessTranscript(messages),
            files: lastUserMessage?.files || [],
            folded: true,
            missingUser: false
        };
    }

    if (!lastUserMessage) {
        return { messageContent: null, files: [], folded: false, missingUser: true };
    }

    return {
        messageContent: lastUserMessage.content,
        files: lastUserMessage.files || [],
        folded: false,
        missingUser: false
    };
}

/**
 * Produce a truncated string representation suitable for prompts.
 * @param {*} value - The value to convert to a string; `null`/`undefined` become an empty string.
 * @param {number} [maxLen=240] - Maximum number of characters to keep before truncation.
 * @returns {string} The stringified value truncated to `maxLen` characters, trimmed of trailing whitespace and appended with `…` if truncation occurred.
 */
export function truncateForPrompt(value, maxLen = 240) {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

/**
 * Produce a compact representation of a JSON Schema by keeping only selected fields and recursively truncating nested schemas.
 * @param {any} schema - The JSON Schema (object or array) to compact. If falsy or not an object, the value is returned unchanged.
 * @param {number} [depth=0] - Current recursion depth; used to limit recursion and description truncation.
 * @returns {any} A compacted schema: for objects, contains only `type`, `enum`, `required`, `default`, a truncated `description`, and compacted `properties`, `items`, `oneOf`, and `anyOf`; for arrays, an array of up to 20 compacted elements; if `depth > 2` or input is not an object/array, returns the original `schema`.
 */
export function compactJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

/**
 * Generate an OpenAI-compatible system prompt that instructs the model how to call the provided tools.
 * @param {Array<Object>} tools - Array of tool descriptors or function-like objects. Each entry should expose a `name`, optional `description`, and optional `parameters` schema (e.g., { name, description, parameters }) or be an object with a `function` property containing those fields.
 * @returns {string} A formatted prompt that lists available tool names, compacted tool schemas, and strict rules for emitting minified JSON `tool_calls`; returns an empty string if `tools` is not a non-empty array.
 */
export function toolsToPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const schemas = tools.map(tool => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        return {
            name: fn.name,
            description: truncateForPrompt(fn.description || '', priorityNames.has(fn.name) ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority: priorityNames.has(fn.name) ? 0 : 1
        };
    }).filter(Boolean).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not prefix names with namespaces.

TOOL CALL OUTPUT FORMAT — respond ONLY with minified JSON, no markdown, no prose:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, answer normally.`;
}

/**
 * Parse model-generated JSON-like tool-call output into a normalized array of tool-call objects.
 * @param {string} content - Raw model output (may be a JSON block, fenced code, or commonly malformed JSON).
 * @returns {Array|null} An array of normalized tool-call objects of the form `{ id, type: 'function', function: { name, arguments }, index }`, or `null` if `content` is not a string or no valid tool calls could be extracted.
 */
export function parseToolCallJson(content) {
    if (typeof content !== 'string') return null;
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 || last !== text.length - 1) {
        if (first >= 0 && last > first) text = text.slice(first, last + 1);
    }
    const parseAttempts = [text];
    // Qwen sometimes emits one missing brace in the common shape:
    // {"tool_calls":[{"name":"x","arguments":{...}}]} -> may become ..."arguments":{...}]}
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls = null;
            if (Array.isArray(parsed.tool_calls)) {
                calls = parsed.tool_calls;
            } else if (parsed.function_call || parsed.tool_call) {
                calls = [parsed.function_call || parsed.tool_call];
            } else if (parsed.name || parsed.tool) {
                calls = [parsed];
            }
            if (!calls || calls.length === 0) continue;
            return calls.map((call, index) => {
                const name = call.name || call.tool || call.function?.name;
                const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments ?? {};
                const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
                if (!name) return null;
                return {
                    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: { name, arguments: args },
                    index
                };
            }).filter(Boolean);
        } catch {
            // try next repair candidate
        }
    }
    return null;
}

/**
 * Append generated tool-calling instructions to a system message when applicable.
 * @param {string|undefined|null} systemMessage - Existing system message text.
 * @param {Array|object|undefined|null} tools - Tool descriptors used to generate the tool prompt.
 * @returns {string|undefined|null} The combined system message with the tool prompt appended and trimmed, or the original `systemMessage` if no tool prompt is produced. 
 */
export function applyToolPrompt(systemMessage, tools) {
    const prompt = toolsToPrompt(tools);
    return prompt ? `${systemMessage || ''}${prompt}`.trim() : systemMessage;
}

/**
 * Construct an OpenAI-compatible assistant response encoding pending tool calls.
 * @param {Object} result - Original execution result used to seed ids, model, usage, and chat identifiers.
 * @param {string} mappedModel - Fallback model identifier to use when `result.model` is absent.
 * @param {Array<Object>} toolCalls - Normalized tool call objects to include in the assistant message; each entry becomes part of `choices[0].message.tool_calls`.
 * @returns {Object} An OpenAI-style completion payload whose first choice is an assistant message with `content: null` and `tool_calls`, `finish_reason: 'tool_calls'`, and preserved usage and chat identifiers.
 */
export function buildOpenAIToolResponse(result, mappedModel, toolCalls) {
    return {
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || 'qwen-max-latest',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.map(({ index, ...call }) => call)
            },
            finish_reason: 'tool_calls'
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId || result.response_id,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId || result.response_id
    };
}

/**
 * Stream OpenAI-style tool-call Server-Sent Events (SSE) to an HTTP response and then close the response.
 *
 * Writes an initial assistant role chunk, one chunk per tool call (each containing a single `tool_calls` entry),
 * a final chunk with `finish_reason: 'tool_calls'`, a `[DONE]` sentinel, and calls `res.end()`.
 *
 * @param {object} res - HTTP response-like object with `write(string)` and `end()` methods where SSE lines are written.
 * @param {string} mappedModel - Fallback model identifier used when `result.model` is not provided.
 * @param {object} result - Source result object; may contain `id` (used as event id) and `model` (used as model name).
 * @param {Array<object>} toolCalls - Ordered array of tool call objects to stream. Each entry should include:
 *   - {number} index - call order index
 *   - {string} id - unique call id
 *   - {object} function - function descriptor to include in the `tool_calls` payload
 */
export function writeToolCallsSse(res, mappedModel, result, toolCalls) {
    const base = {
        id: result.id || 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || 'qwen-max-latest'
    };
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }) + '\n\n');
    for (const call of toolCalls) {
        res.write('data: ' + JSON.stringify({
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: call.index,
                        id: call.id,
                        type: 'function',
                        function: call.function
                    }]
                },
                finish_reason: null
            }]
        }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
}
