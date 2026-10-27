'use strict';

// Silly Prefill: Additional Parameters for every Chat Completion source.
//
// SillyTavern builds the upstream request body from a fixed set of fields per
// source, so unknown fields from the client are dropped. This plugin:
//   1. takes `sp_additional_params` out of POST /api/backends/chat-completions/generate,
//   2. remembers it for that request only (AsyncLocalStorage),
//   3. edits the first outgoing JSON POST that SillyTavern makes while handling
//      it (the request to the provider): merge body, drop keys, add headers.
// Nothing is sent anywhere else; the API key is never read or logged.

const http = require('node:http');
const https = require('node:https');
const { AsyncLocalStorage } = require('node:async_hooks');

const PLUGIN_ID = 'silly-prefill-params';
const FIELD = 'sp_additional_params';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const MOUNT_PATH = '/api/backends/chat-completions';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

// Auth headers are protected so a profile can't silently replace the saved key;
// the rest are managed by Node itself.
const BLOCKED_HEADERS = new Set([
    'authorization', 'x-api-key', 'x-goog-api-key', 'api-key',
    'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
    'proxy-authorization', 'te', 'trailer',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const storage = new AsyncLocalStorage();
const originals = { http: http.request, https: https.request };
let middlewareInstalled = false;
let requestsPatched = false;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        if (isPlainObject(value) && isPlainObject(target[key])) {
            deepMerge(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

// Supports dotted paths for nested keys, e.g. "generationConfig.topK".
function deletePath(target, path) {
    if (Object.hasOwn(target, path)) {
        delete target[path];
        return;
    }
    const parts = path.split('.');
    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!isPlainObject(node?.[parts[i]])) return;
        node = node[parts[i]];
    }
    delete node[parts[parts.length - 1]];
}

function sanitize(raw) {
    if (!isPlainObject(raw)) return null;

    const body = isPlainObject(raw.body) ? JSON.parse(JSON.stringify(raw.body)) : {};
    const exclude = Array.isArray(raw.exclude)
        ? raw.exclude.filter(key => typeof key === 'string' && key.length > 0)
        : [];
    const headers = {};
    if (isPlainObject(raw.headers)) {
        for (const [name, value] of Object.entries(raw.headers)) {
            const lower = String(name).toLowerCase().trim();
            if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower) || BLOCKED_HEADERS.has(lower)) continue;
            const text = String(value ?? '');
            if (/[\r\n]/.test(text)) continue;
            headers[name] = text;
        }
    }

    let claudeThinking = null;
    const ct = raw.claude_thinking;
    if (isPlainObject(ct) && typeof ct.tool_use_id === 'string' && typeof ct.signature === 'string' && ct.signature.trim()) {
        claudeThinking = {
            tool_use_id: ct.tool_use_id,
            signature: ct.signature.trim(),
            thinking: typeof ct.thinking === 'string' ? ct.thinking : '',
        };
    }

    if (!Object.keys(body).length && !exclude.length && !Object.keys(headers).length && !claudeThinking) return null;
    return { body, exclude, headers, claudeThinking, used: false };
}

// Anthropic: with thinking enabled, the assistant turn that holds the latest
// tool_use must start with a signed thinking block.
function insertClaudeThinking(json, claudeThinking) {
    if (!claudeThinking || !Array.isArray(json.messages)) return false;
    for (const message of json.messages) {
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
        const hasCall = message.content.some(block => block?.type === 'tool_use' && block.id === claudeThinking.tool_use_id);
        if (!hasCall) continue;
        if (message.content[0]?.type === 'thinking' || message.content[0]?.type === 'redacted_thinking') return false;
        message.content.unshift({
            type: 'thinking',
            thinking: claudeThinking.thinking,
            signature: claudeThinking.signature,
        });
        return true;
    }
    return false;
}

function isJsonPost(options) {
    if (String(options?.method ?? 'GET').toUpperCase() !== 'POST') return false;
    const headers = options?.headers ?? {};
    const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    return /application\/json/i.test(String(type ?? ''));
}

function patchClientRequest(req, params) {
    const chunks = [];
    let size = 0;
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);

    const restore = () => {
        req.write = originalWrite;
        req.end = originalEnd;
    };

    req.write = function (chunk, encoding, callback) {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }
        if (chunk !== undefined && chunk !== null) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            size += buffer.length;
            chunks.push(buffer);
        }
        if (size > MAX_BODY_BYTES) {
            // Too big to rewrite safely: send as-is.
            restore();
            const data = Buffer.concat(chunks.splice(0));
            return originalWrite(data, callback);
        }
        if (typeof callback === 'function') process.nextTick(callback);
        return true;
    };

    req.end = function (chunk, encoding, callback) {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
        } else if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }
        if (chunk !== undefined && chunk !== null) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        }
        restore();

        let output = Buffer.concat(chunks);
        try {
            const json = JSON.parse(output.toString('utf8'));
            if (isPlainObject(json)) {
                deepMerge(json, params.body);
                for (const key of params.exclude) deletePath(json, key);
                const thinkingInserted = insertClaudeThinking(json, params.claudeThinking);
                output = Buffer.from(JSON.stringify(json), 'utf8');
                if (!req.headersSent) {
                    for (const [name, value] of Object.entries(params.headers)) req.setHeader(name, value);
                    req.setHeader('Content-Length', output.length);
                }
                console.info(`[${PLUGIN_ID}] Applied: body keys [${Object.keys(params.body).join(', ')}], excluded [${params.exclude.join(', ')}], headers [${Object.keys(params.headers).join(', ')}]${thinkingInserted ? ', claude thinking block inserted' : ''}`);
            }
        } catch (error) {
            console.warn(`[${PLUGIN_ID}] Request body is not JSON, sent unchanged: ${error.message}`);
        }
        return originalEnd(output, callback);
    };
}

function wrapRequest(original) {
    return function patchedRequest(...args) {
        const params = storage.getStore();
        if (!params || params.used) return original.apply(this, args);

        const options = args.find(arg => isPlainObject(arg) && !(arg instanceof URL));
        if (!isJsonPost(options)) return original.apply(this, args);

        params.used = true;
        const req = original.apply(this, args);
        patchClientRequest(req, params);
        return req;
    };
}

function patchOutgoingRequests() {
    if (requestsPatched) return;
    http.request = wrapRequest(originals.http);
    https.request = wrapRequest(originals.https);
    requestsPatched = true;
}

function generateMiddleware(req, res, next) {
    if (req.method !== 'POST' || req.path !== GENERATE_PATH || !isPlainObject(req.body) || !(FIELD in req.body)) {
        return next();
    }

    const params = sanitize(req.body[FIELD]);
    delete req.body[FIELD];
    if (!params) return next();

    storage.run(params, next);
}

/**
 * Plugins are loaded after the core routes, so the middleware is moved in front
 * of the chat-completions router (after body parsing, CSRF and user auth).
 */
function installMiddleware(app) {
    if (middlewareInstalled) return true;
    const router = app?._router ?? app?.router;
    const stack = router?.stack;
    if (!Array.isArray(stack)) return false;

    const targetIndex = stack.findIndex(layer => !layer.regexp?.fast_slash
        && layer.regexp?.test?.(MOUNT_PATH)
        && layer.name === 'router');
    if (targetIndex < 0) return false;

    app.use(generateMiddleware);
    const layer = stack.pop();
    stack.splice(targetIndex, 0, layer);
    patchOutgoingRequests();
    middlewareInstalled = true;
    console.info(`[${PLUGIN_ID}] Additional Parameters hook installed.`);
    return true;
}

async function init(router) {
    router.use((req, _res, next) => {
        installMiddleware(req.app);
        next();
    });
    router.get('/status', (_req, res) => {
        res.json({ ok: middlewareInstalled, id: PLUGIN_ID, version: '1.1.0' });
    });
}

async function exit() {
    if (requestsPatched) {
        http.request = originals.http;
        https.request = originals.https;
        requestsPatched = false;
    }
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Silly Prefill: Additional Parameters',
        description: 'Applies Silly Prefill Additional Parameters (body/exclude/headers) to every Chat Completion source.',
    },
};
