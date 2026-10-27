// Silly Prefill: external block chain.
// After the main model replies, other connection profiles can add blocks above
// or below the message, rewrite it, or produce hidden notes for later steps.

const SEPARATOR = '\n\n';
const MAX_REWRITE_HISTORY = 5;
const POST_PROCESSING_UPGRADES = Object.freeze({ claude: 'merge_tools', merge: 'merge_tools', semi: 'semi_tools', strict: 'strict_tools' });
// These forward messages as-is, so the signature must be in Gemini's OpenAI-compat format.
const OPENAI_COMPAT_SOURCES = new Set(['openai', 'custom', 'aimlapi', 'cometapi', 'electronhub', 'nanogpt', 'pollinations']);

export const BLOCK_MODES = Object.freeze({
    TOP: 'top',
    BOTTOM: 'bottom',
    REWRITE: 'rewrite',
    SILENT: 'silent',
});

const MODE_LABELS = {
    top: 'Attach above the message',
    bottom: 'Attach below the message',
    rewrite: 'Rewrite the message',
    silent: 'Hidden (only for later blocks / macros)',
};

const PREFILL_MODES = {
    none: 'No prefill',
    assistant: 'Assistant message (classic)',
    function: 'Function response (Gemini 3/4, Claude)',
};

const MACRO_HELP = [
    ['{{lastOriginalMessage}}', 'Target message without blocks (what the main model wrote)'],
    ['{{targetMessage}}', 'Target message with the blocks attached so far'],
    ['{{topPos}} / {{bottomPos}}', 'Blocks already attached above / below'],
    ['{{captureChar}} / {{captureChar::2}}', 'Last (or N-th last) character message, without blocks'],
    ['{{captureUser}} / {{captureUser::2}}', 'Last (or N-th last) user message before the target'],
    ['{{prevOutput}}', 'Raw output of the previous block in this run'],
    ['{{blockOutput::Name}}', 'Output of a block by name (this message)'],
    ['{{chainHistory::10}}', 'Last N messages as "Name: text" (respects Chat history mode)'],
    ['{{startWith}}', 'The block\'s Start With text'],
    ['{{toolRequest}}', 'Request text when the block is called as a tool'],
    ['{{output}}', 'In the wrapper template only: the block output'],
];

let api = null;
let running = null; // { controller, messageId }
const ctx = () => SillyTavern.getContext();

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function uid() {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function createBlock(overrides = {}) {
    return {
        id: uid(),
        name: 'New block',
        enabled: true,
        autoRun: true,
        profileId: '',
        mode: BLOCK_MODES.BOTTOM,
        historyMode: 'original',
        includeInContext: false,
        wrapper: '{{output}}',
        prompts: [
            { role: 'system', enabled: true, content: 'You are an assistant that adds a short block to a roleplay message.' },
            { type: 'history', enabled: true, count: 6 },
            { role: 'user', enabled: true, content: 'Message from {{char}}:\n{{lastOriginalMessage}}\n\nWrite the block.' },
        ],
        prefillMode: 'none',
        prefill: '',
        startWith: '',
        maxTokens: 800,
        temperature: '',
        usePreset: true,
        condition: '',
        extractRegex: '',
        exposeAsTool: false,
        toolDescription: '',
        ...overrides,
    };
}

function normalizeBlock(raw) {
    const block = { ...createBlock(), ...(raw && typeof raw === 'object' ? raw : {}) };
    block.id = String(block.id || uid());
    block.name = String(block.name ?? 'Block');
    if (!Object.values(BLOCK_MODES).includes(block.mode)) block.mode = BLOCK_MODES.BOTTOM;
    // Legacy rewrites always entered history; top/bottom used includeInContext.
    block.historyMode = ['result', 'original'].includes(raw?.historyMode)
        ? raw.historyMode
        : block.mode === BLOCK_MODES.REWRITE || raw?.includeInContext ? 'result' : 'original';
    block.includeInContext = block.historyMode === 'result';
    if (!Object.hasOwn(PREFILL_MODES, block.prefillMode)) block.prefillMode = 'none';
    block.prompts = Array.isArray(block.prompts) ? block.prompts.map(p => (p?.type === 'history'
        ? { type: 'history', enabled: p.enabled !== false, count: Math.max(0, Number(p.count) || 0) }
        : { role: ['system', 'user', 'assistant'].includes(p?.role) ? p.role : 'user', enabled: p?.enabled !== false, content: String(p?.content ?? '') })) : [];
    block.maxTokens = Math.max(1, Number(block.maxTokens) || 800);
    for (const key of ['enabled', 'autoRun', 'includeInContext', 'usePreset', 'exposeAsTool']) block[key] = Boolean(block[key]);
    return block;
}

export function normalizeChainSettings(raw) {
    const chain = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: chain.enabled === true,
        runOnSwipe: chain.runOnSwipe !== false,
        runOnContinue: chain.runOnContinue === true,
        blocks: Array.isArray(chain.blocks) ? chain.blocks.map(normalizeBlock) : [],
        selectedBlockId: String(chain.selectedBlockId ?? ''),
    };
}

const chainSettings = () => api.getSettings().chain;
const save = () => api.saveSettingsDebounced();

/* -------------------------------------------------------------------------- */
/* Message state                                                              */
/* -------------------------------------------------------------------------- */

function joinParts(...parts) {
    return parts.filter(p => typeof p === 'string' && p.length > 0).join(SEPARATOR);
}

/**
 * Returns the chain state of a message, resetting it when the visible text no
 * longer matches what the chain composed (new swipe, regenerate, manual edit).
 */
function getState(message) {
    message.extra ??= {};
    const state = message.extra.sp_chain;
    if (!state || typeof state !== 'object' || state.composed !== message.mes) {
        message.extra.sp_chain = { original: String(message.mes ?? ''), composed: String(message.mes ?? ''), blocks: {}, rewrites: [] };
        delete message.extra.display_text;
    }
    return message.extra.sp_chain;
}

function orderedBlockStates(state, mode) {
    const order = chainSettings().blocks.map(b => b.id);
    // Blocks deleted from the settings are dropped the next time the message is rebuilt.
    return Object.entries(state.blocks)
        .filter(([id, b]) => b.mode === mode && b.wrapped && order.includes(id))
        .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
        .map(([, b]) => b);
}

function composeParts(state) {
    const tops = orderedBlockStates(state, BLOCK_MODES.TOP);
    const bottoms = orderedBlockStates(state, BLOCK_MODES.BOTTOM);
    const pick = (list, ctxOnly) => list.filter(b => !ctxOnly || b.includeInContext).map(b => b.wrapped).join(SEPARATOR);
    const rewrite = state.rewrite?.output && chainSettings().blocks.some(b => b.id === state.rewrite.blockId)
        ? state.rewrite : null;
    return {
        bodyAll: rewrite ? rewrite.output : state.original,
        bodyCtx: rewrite?.includeInContext ? rewrite.output : state.original,
        topAll: pick(tops, false),
        bottomAll: pick(bottoms, false),
        topCtx: pick(tops, true),
        bottomCtx: pick(bottoms, true),
    };
}

async function applyState(messageId, message) {
    const state = message.extra.sp_chain;
    const parts = composeParts(state);
    const mes = joinParts(parts.topCtx, parts.bodyCtx, parts.bottomCtx);
    const display = joinParts(parts.topAll, parts.bodyAll, parts.bottomAll);

    message.mes = mes;
    state.composed = mes;
    const c = ctx();
    // Stock Translate clears display_text on MESSAGE_UPDATED even with auto
    // translation off. Notify first, then commit our display/swipe projection.
    await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, messageId);
    if (display !== mes) {
        message.extra.display_text = display;
    } else {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = mes;
        const info = message.swipe_info?.[message.swipe_id];
        if (info && typeof info === 'object') {
            info.extra = structuredClone(message.extra);
        }
    }

    if (document.querySelector(`#chat .mes[mesid="${messageId}"]`)) {
        c.updateMessageBlock(messageId, message);
    }
    await c.saveChat();
}

/* -------------------------------------------------------------------------- */
/* Macros                                                                     */
/* -------------------------------------------------------------------------- */

function originalText(message) {
    const state = message?.extra?.sp_chain;
    return state && state.composed === message.mes ? state.original : String(message?.mes ?? '');
}

function isCharMessage(m) {
    return m && !m.is_user && !m.is_system;
}

function findLastIndex(predicate, before = Infinity) {
    const chat = ctx().chat ?? [];
    for (let i = Math.min(chat.length, before) - 1; i >= 0; i--) {
        if (predicate(chat[i])) return i;
    }
    return -1;
}

function captureNth(predicate, n, before) {
    const chat = ctx().chat ?? [];
    let seen = 0;
    for (let i = Math.min(chat.length, before) - 1; i >= 0; i--) {
        if (predicate(chat[i]) && ++seen >= Math.max(1, Number(n) || 1)) return originalText(chat[i]);
    }
    return '';
}

function chatHistory(count, before) {
    const chat = ctx().chat ?? [];
    const lines = [];
    for (let i = Math.min(chat.length, before) - 1; i >= 0 && lines.length < count; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        lines.unshift(`${m.name}: ${String(m.mes ?? '')}`);
    }
    return lines.join('\n\n');
}

function argMacro(handler, argName) {
    return {
        unnamedArgs: [{ name: argName, optional: true }],
        handler: ({ unnamedArgs: [arg] }) => String(handler(arg) ?? ''),
    };
}

/** Per-run macros (override the global ones inside block prompts). */
function buildRunMacros(run) {
    const { messageId, message, state, block, prevOutput, toolRequest } = run;
    const parts = state ? composeParts(state) : { topAll: '', bottomAll: '' };
    const outputsByName = {};
    for (const b of Object.values(state?.blocks ?? {})) outputsByName[b.name.toLowerCase()] = b.output;
    return {
        lastOriginalMessage: () => state?.original ?? originalText(message),
        targetMessage: () => joinParts(parts.topAll, parts.bodyAll ?? state?.original ?? '', parts.bottomAll),
        topPos: () => parts.topAll,
        bottomPos: () => parts.bottomAll,
        captureChar: argMacro(n => captureNth(isCharMessage, n, messageId + 1), 'n'),
        captureUser: argMacro(n => captureNth(m => m?.is_user, n, messageId), 'n'),
        prevOutput: () => prevOutput ?? '',
        blockOutput: argMacro(name => outputsByName[String(name ?? '').toLowerCase()] ?? '', 'name'),
        chainHistory: argMacro(n => chatHistory(Number(n) || 10, messageId), 'count'),
        startWith: () => block?.startWith ? resolve(block.startWith, run, false) : '',
        toolRequest: () => toolRequest ?? '',
    };
}

function resolve(text, run, withRun = true) {
    const dynamicMacros = withRun ? buildRunMacros(run) : {};
    return ctx().substituteParams(String(text ?? ''), { dynamicMacros });
}

/** Global macros, usable in the main preset as well. */
function registerGlobalMacros() {
    const c = ctx();
    const lastCharIndex = () => findLastIndex(isCharMessage);
    const defs = {
        lastOriginalMessage: { description: 'Last character message without Silly Prefill blocks', handler: () => { const i = lastCharIndex(); return i < 0 ? '' : originalText(c.chat[i]); } },
        topPos: { description: 'Silly Prefill blocks above the last character message', handler: () => { const i = lastCharIndex(); return i < 0 ? '' : composeParts(getStateReadOnly(c.chat[i])).topAll; } },
        bottomPos: { description: 'Silly Prefill blocks below the last character message', handler: () => { const i = lastCharIndex(); return i < 0 ? '' : composeParts(getStateReadOnly(c.chat[i])).bottomAll; } },
        captureChar: { description: 'N-th last character message without blocks (default 1)', ...argMacro(n => captureNth(isCharMessage, n, Infinity), 'n') },
        captureUser: { description: 'N-th last user message (default 1)', ...argMacro(n => captureNth(m => m?.is_user, n, Infinity), 'n') },
        chainHistory: { description: 'Last N messages as "Name: text", respecting each block history mode', ...argMacro(n => chatHistory(Number(n) || 10, Infinity), 'count') },
    };

    for (const [name, def] of Object.entries(defs)) {
        try {
            if (c.macros?.register) {
                c.macros.register(name, { category: 'Silly Prefill', ...def });
            } else {
                c.registerMacro?.(name, () => def.handler({ unnamedArgs: [] }), def.description);
            }
        } catch (error) {
            console.warn(`[Silly Prefill] Could not register macro ${name}:`, error);
        }
    }
}

function getStateReadOnly(message) {
    const state = message?.extra?.sp_chain;
    if (state && state.composed === message.mes) return state;
    return { original: String(message?.mes ?? ''), blocks: {} };
}

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

function getProfile(profileId) {
    const service = ctx().ConnectionManagerRequestService;
    if (!profileId) throw new Error('No connection profile selected for this block.');
    const profile = service.getProfile(profileId);
    const apiMap = service.validateProfile(profile);
    return { profile, apiMap };
}

function historyMessages(count, messageId) {
    const chat = ctx().chat ?? [];
    const out = [];
    for (let i = messageId - 1; i >= 0 && out.length < count; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        out.unshift({ role: m.is_user ? 'user' : 'assistant', content: String(m.mes ?? '') });
    }
    return out;
}

/**
 * Builds the messages and override payload for a block run.
 * @returns {{ messages: object[], overridePayload: object, source: string, startWith: string }}
 */
export function buildBlockRequest(block, run) {
    const { profile, apiMap } = getProfile(block.profileId);
    const source = String(apiMap.source ?? '');
    const messages = [];

    for (const entry of block.prompts) {
        if (!entry.enabled) continue;
        if (entry.type === 'history') {
            messages.push(...historyMessages(entry.count, run.messageId));
            continue;
        }
        const content = resolve(entry.content, run);
        if (content.trim()) messages.push({ role: entry.role, content });
    }

    const startWith = block.startWith ? resolve(block.startWith, run) : '';
    const prefillText = joinPrefill(block.prefill ? resolve(block.prefill, run) : '', startWith);
    const overridePayload = {};

    if (block.temperature !== '' && Number.isFinite(Number(block.temperature))) {
        overridePayload.temperature = Number(block.temperature);
    }

    if (prefillText && block.prefillMode === 'assistant') {
        messages.push({ role: 'assistant', content: prefillText });
    } else if (prefillText && block.prefillMode === 'function') {
        if (apiMap.selected !== 'openai') throw new Error('Function prefill needs a Chat Completion profile.');
        const id = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const call = { id, type: 'function', function: { name: api.TOOL_NAME, arguments: JSON.stringify({ mode: 'assistant_prefill' }) } };
        const settings = api.getSettings();
        const gptTarget = api.isGptModel?.(profile.model) === true;
        if (gptTarget && !settings.enableGpt) throw new Error('GPT function-prefill is disabled.');
        const geminiTarget = source === 'makersuite' || source === 'vertexai' || api.isGeminiModel(profile.model);
        const token = geminiTarget && settings.thoughtSignatureMode === 'argon-exp-proto-v2'
            ? api.resolveGeminiThoughtSignature({ model: profile.model, chat_completion_source: source }, settings).signature
            : 'skip_thought_signature_validator';
        if (!gptTarget && OPENAI_COMPAT_SOURCES.has(source)) {
            if (token) call.extra_content = { google: { thought_signature: token } };
        } else if (!gptTarget) {
            if (token) call.signature = token;
        }
        const assistant = { role: 'assistant', content: '', tool_calls: [call] };
        if (gptTarget) {
            const info = api.resolveGptThoughtSignature({ model: profile.model, chat_completion_source: source }, settings);
            if (info.signature) assistant.reasoning_details = [{ type: 'reasoning.encrypted', id: `rs_${id}`,
                data: info.signature, format: 'openai-responses-v1', index: 0 }];
        }
        messages.push(
            assistant,
            { role: 'tool', ...(source === 'claude' || gptTarget ? {} : { name: api.TOOL_NAME }), tool_call_id: id, content: prefillText },
        );
        if (gptTarget) {
            if (settings.enableGptToolDeclaration) api.registerPrefillTool(overridePayload, settings.geminiToolDescription, true);
        } else if (source !== 'claude' && geminiTarget) {
            if (settings.enableGeminiToolDeclaration) {
                api.registerPrefillTool(overridePayload, settings.geminiToolDescription, false, settings.geminiFunctionCallingMode, settings.geminiAllowedFunctionNames);
            }
        } else {
            // Keep non-Gemini block behavior independent of the Gemini selector.
            overridePayload.tools = [api.buildPrefillToolDeclaration()];
            overridePayload.tool_choice = 'auto';
        }
        const post = String(profile['prompt-post-processing'] ?? '');
        if (post === 'single') throw new Error('Function prefill does not work with "Single user message" post-processing.');
        if (POST_PROCESSING_UPGRADES[post]) overridePayload.custom_prompt_post_processing = POST_PROCESSING_UPGRADES[post];
    }

    return { messages, overridePayload, source, startWith };
}

function joinPrefill(prefill, startWith) {
    if (!startWith) return prefill;
    if (!prefill) return startWith;
    return `${prefill}${/\s$/.test(prefill) ? '' : '\n'}${startWith}`;
}

function postProcess(block, raw, startWith, run) {
    let text = String(raw ?? '').trim();
    if (block.extractRegex) {
        try {
            const match = new RegExp(block.extractRegex, 's').exec(text);
            if (match) text = String(match[1] ?? match[0]).trim();
        } catch (error) {
            throw new Error(`Invalid extract regex: ${error.message}`);
        }
    }
    if (startWith && !text.startsWith(startWith.trim())) {
        text = `${startWith}${text}`;
    }
    const wrapper = block.wrapper || '{{output}}';
    const wrapped = resolve(wrapper.replace(/\{\{output\}\}/gi, '\u0000SP_OUTPUT\u0000'), run).replace(/\u0000SP_OUTPUT\u0000/g, text);
    return { output: text, wrapped: text ? wrapped : '' };
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

async function generate(block, run, signal) {
    const { messages, overridePayload, startWith } = buildBlockRequest(block, run);
    if (!messages.length) throw new Error('The block prompt is empty.');
    const service = ctx().ConnectionManagerRequestService;
    const result = await service.sendRequest(block.profileId, messages, block.maxTokens, {
        stream: false,
        signal,
        extractData: true,
        includePreset: block.usePreset,
        includeInstruct: true,
    }, overridePayload);
    const content = typeof result === 'string' ? result : result?.content;
    return postProcess(block, content, startWith, run);
}

function shouldRun(block, state) {
    if (!block.enabled || !block.profileId) return false;
    if (!block.condition) return true;
    try {
        return new RegExp(block.condition, 'is').test(state.original);
    } catch {
        return false;
    }
}

/**
 * Runs blocks on a message in list order. Each block sees the outputs of the
 * blocks before it ({{prevOutput}}, {{topPos}}, {{blockOutput::name}}).
 */
export async function runChain(messageId, { blockIds = null, manual = false } = {}) {
    const c = ctx();
    const message = c.chat?.[messageId];
    if (!isCharMessage(message)) throw new Error('Blocks run only on character messages.');
    if (running) throw new Error('The chain is already running.');

    const blocks = chainSettings().blocks.filter(b => (blockIds ? blockIds.includes(b.id) : (manual || b.autoRun)));
    const state = getState(message);
    for (const b of blocks) {
        if (b.enabled && !b.profileId) toastr.warning(`Block "${b.name}" has no connection profile selected, so it was skipped.`, 'Silly Prefill chain');
    }
    const toRun = blocks.filter(b => shouldRun(b, state));
    if (!toRun.length) return 0;

    const controller = new AbortController();
    running = { controller, messageId };
    setRunningUi(true);
    let prevOutput = '';
    let done = 0;

    try {
        for (const block of toRun) {
            if (controller.signal.aborted) break;
            api.setStatus('idle', `Chain: ${block.name}...`);
            const run = { messageId, message, state, block, prevOutput };
            try {
                const { output, wrapped } = await generate(block, run, controller.signal);
                if (c.chat?.[messageId] !== message) throw new Error('The chat changed during generation.');
                prevOutput = output;
                if (block.mode === BLOCK_MODES.REWRITE) {
                    if (output) {
                        state.rewrites = [...(state.rewrites ?? []), state.rewrite ? structuredClone(state.rewrite) : null].slice(-MAX_REWRITE_HISTORY);
                        state.rewrite = { blockId: block.id, output, includeInContext: block.historyMode !== 'original' };
                    }
                    state.blocks[block.id] = { name: block.name, mode: block.mode, output, wrapped: '', includeInContext: block.historyMode !== 'original', at: Date.now() };
                } else {
                    state.blocks[block.id] = { name: block.name, mode: block.mode, output, wrapped, includeInContext: block.includeInContext, at: Date.now() };
                }
                await applyState(messageId, message);
                done++;
            } catch (error) {
                if (controller.signal.aborted) break;
                console.error(`[Silly Prefill] Block "${block.name}" failed:`, error);
                toastr.error(`${block.name}: ${error?.cause?.message ?? error.message}`, 'Silly Prefill chain');
            }
        }
    } finally {
        running = null;
        setRunningUi(false);
        api.setStatus(done ? 'success' : 'idle', `Chain finished: ${done}/${toRun.length} block(s).`);
    }
    return done;
}

export function stopChain() {
    running?.controller.abort();
}

async function removeBlocks(messageId, blockId = null) {
    const message = ctx().chat?.[messageId];
    if (!message?.extra?.sp_chain) return;
    const state = getState(message);
    if (blockId) delete state.blocks[blockId]; else state.blocks = {};
    if (!blockId || state.rewrite?.blockId === blockId) delete state.rewrite;
    if (!blockId) state.rewrites = [];
    await applyState(messageId, message);
}

async function undoRewrite(messageId) {
    const message = ctx().chat?.[messageId];
    const state = message && getState(message);
    if (!state?.rewrites?.length) throw new Error('Nothing to undo.');
    const previous = state.rewrites.pop();
    if (typeof previous === 'string') {
        // Legacy snapshots predate separate original/rewrite storage.
        state.original = previous;
        delete state.rewrite;
    } else if (previous?.output) {
        state.rewrite = previous;
    } else {
        delete state.rewrite;
    }
    await applyState(messageId, message);
}

/* -------------------------------------------------------------------------- */
/* Events, tools, commands                                                    */
/* -------------------------------------------------------------------------- */

async function onMessageReceived(messageId, type) {
    const settings = chainSettings();
    if (!settings.enabled || running) return;
    const t = String(type ?? '');
    if (['quiet', 'impersonate', 'first_message', 'command', 'extension'].includes(t)) return;
    if (t === 'swipe' && !settings.runOnSwipe) return;
    if (t === 'continue' && !settings.runOnContinue) return;
    const id = Number(messageId);
    if (!isCharMessage(ctx().chat?.[id])) return;
    // Let other MESSAGE_RECEIVED handlers (e.g. "show prefill in chat") finish first.
    setTimeout(() => runChain(id).catch(error => toastr.error(error.message, 'Silly Prefill chain')), 0);
}

function toolName(block) {
    return `sp_block_${block.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || block.id}`;
}

let registeredTools = [];

export function syncTools() {
    const c = ctx();
    if (!c.registerFunctionTool) return;
    for (const name of registeredTools) c.unregisterFunctionTool(name);
    registeredTools = [];
    if (!chainSettings().enabled) return;

    for (const block of chainSettings().blocks.filter(b => b.enabled && b.exposeAsTool && b.profileId)) {
        const name = toolName(block);
        c.registerFunctionTool({
            name,
            displayName: `Silly block: ${block.name}`,
            description: block.toolDescription || `Ask the "${block.name}" helper model. Pass what you need in "request".`,
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: { request: { type: 'string', description: 'What the helper should do or answer.' } },
                required: ['request'],
            },
            action: async ({ request }) => {
                const chat = c.chat ?? [];
                const messageId = Math.max(0, findLastIndex(isCharMessage));
                const message = chat[messageId] ?? { mes: '' };
                const state = getStateReadOnly(message);
                const { output } = await generate(block, { messageId, message, state, block, toolRequest: String(request ?? '') });
                return output || '[empty]';
            },
            formatMessage: () => `Asking ${block.name}...`,
        });
        registeredTools.push(name);
    }
}

function registerCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser?.addCommandObject) return;
    const lastCharId = () => findLastIndex(isCharMessage);
    const byName = name => chainSettings().blocks.filter(b => b.name.toLowerCase() === String(name).toLowerCase());

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-chain',
        helpString: 'Run Silly Prefill blocks on a message. Without "block" runs all enabled blocks.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'block', description: 'Block name', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message id', typeList: [ARGUMENT_TYPE.NUMBER] })],
        callback: async (args, value) => {
            const id = value !== '' && value !== undefined ? Number(value) : lastCharId();
            const ids = args.block ? byName(args.block).map(b => b.id) : null;
            if (args.block && !ids.length) throw new Error(`Block "${args.block}" not found.`);
            return String(await runChain(id, { blockIds: ids, manual: true }));
        },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-chain-stop',
        helpString: 'Stop the running Silly Prefill chain.',
        callback: () => { stopChain(); return ''; },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-chain-clear',
        helpString: 'Remove Silly Prefill blocks from a message (last character message by default).',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message id', typeList: [ARGUMENT_TYPE.NUMBER] })],
        callback: async (_args, value) => { await removeBlocks(value !== '' && value !== undefined ? Number(value) : lastCharId()); return ''; },
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sp-chain-undo',
        helpString: 'Undo the last block rewrite of a message.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message id', typeList: [ARGUMENT_TYPE.NUMBER] })],
        callback: async (_args, value) => { await undoRewrite(value !== '' && value !== undefined ? Number(value) : lastCharId()); return ''; },
    }));
}

/** Adds a "run chain" button to every message (via the message template). */
function addMessageButton() {
    const template = document.querySelector('#message_template .extraMesButtons');
    if (template && !template.querySelector('.sp_chain_run')) {
        const button = document.createElement('div');
        button.className = 'mes_button sp_chain_run fa-solid fa-link';
        button.title = 'Silly Prefill: run blocks (Shift+click: remove blocks)';
        template.prepend(button);
    }
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(container => {
        if (!container.querySelector('.sp_chain_run')) {
            const button = document.createElement('div');
            button.className = 'mes_button sp_chain_run fa-solid fa-link';
            button.title = 'Silly Prefill: run blocks (Shift+click: remove blocks)';
            container.prepend(button);
        }
    });
    $(document).off('click.spChain').on('click.spChain', '.sp_chain_run', async function (event) {
        const id = Number($(this).closest('.mes').attr('mesid'));
        try {
            if (event.shiftKey) await removeBlocks(id);
            else await runChain(id, { manual: true });
        } catch (error) {
            toastr.error(error.message, 'Silly Prefill chain');
        }
    });
}

function onMessageEdited(messageId) {
    const message = ctx().chat?.[Number(messageId)];
    const state = message?.extra?.sp_chain;
    if (!state || state.composed === message.mes) return;
    // The user edited the text: keep blocks only if they are still recognisable.
    const parts = composeParts(state);
    let text = String(message.mes ?? '');
    if (parts.topCtx && text.startsWith(parts.topCtx + SEPARATOR)) text = text.slice(parts.topCtx.length + SEPARATOR.length);
    if (parts.bottomCtx && text.endsWith(SEPARATOR + parts.bottomCtx)) text = text.slice(0, -(parts.bottomCtx.length + SEPARATOR.length));
    const blocksStillThere = (!parts.topCtx || message.mes.startsWith(parts.topCtx)) && (!parts.bottomCtx || message.mes.endsWith(parts.bottomCtx));
    if (!blocksStillThere) {
        delete message.extra.sp_chain;
        delete message.extra.display_text;
        return;
    }
    if (state.rewrite?.includeInContext && parts.bodyCtx === state.rewrite.output) {
        state.rewrite.output = text;
        if (state.blocks[state.rewrite.blockId]) state.blocks[state.rewrite.blockId].output = text;
    } else {
        state.original = text;
        delete state.rewrite;
    }
    // messageEditDone re-renders the raw text right after this event; render ours afterwards.
    setTimeout(() => void applyState(Number(messageId), message), 0);
}

/* -------------------------------------------------------------------------- */
/* UI                                                                         */
/* -------------------------------------------------------------------------- */

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
}

function field(label, control, hint) {
    return el('div', { class: 'sp-ui-field' }, [el('label', { text: label, ...(control.id ? { for: control.id } : {}) }), control, hint ? el('small', { text: hint }) : null]);
}

function checkbox(label, hint, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked, on: { change: () => onChange(input.checked) } });
    return el('label', { class: 'sp-ui-toggle' }, [input, el('span', {}, [el('strong', { text: label }), hint ? el('small', { text: hint }) : null])]);
}

function textarea(value, rows, onInput, placeholder = '') {
    const node = el('textarea', { class: 'text_pole', rows, spellcheck: false, value, placeholder, on: { input: () => onInput(node.value) } });
    return node;
}

function select(options, value, onChange) {
    const node = el('select', { class: 'text_pole', on: { change: () => onChange(node.value) } });
    for (const [v, label] of Object.entries(options)) node.append(el('option', { value: v, text: label }));
    node.value = value;
    return node;
}

function button(label, onClick, title = '') {
    return el('input', { type: 'button', class: 'menu_button', value: label, title, on: { click: onClick } });
}

function setRunningUi(isRunning) {
    const stop = document.getElementById('sp_chain_stop');
    if (stop) stop.disabled = !isRunning;
}

function getProfileOptions() {
    const options = { '': '— select a connection profile —' };
    try {
        for (const p of ctx().ConnectionManagerRequestService.getSupportedProfiles()) options[p.id] = p.name;
    } catch (error) {
        options[''] = `Connection Manager unavailable: ${error.message}`;
    }
    return options;
}

function selectedBlock() {
    const settings = chainSettings();
    return settings.blocks.find(b => b.id === settings.selectedBlockId) ?? settings.blocks[0] ?? null;
}

export function renderChainUi() {
    const root = document.getElementById('sp_chain_root');
    if (!root) return;
    const settings = chainSettings();
    root.replaceChildren();

    root.append(
        checkbox('Enable external blocks', 'Runs the blocks below after every character reply.', settings.enabled, v => { settings.enabled = v; save(); syncTools(); }),
        checkbox('Run on swipes / regenerate', '', settings.runOnSwipe, v => { settings.runOnSwipe = v; save(); }),
        checkbox('Run after Continue', 'Continue changes the text, so existing blocks are rebuilt.', settings.runOnContinue, v => { settings.runOnContinue = v; save(); }),
    );

    // Block list
    const listOptions = {};
    settings.blocks.forEach((b, i) => { listOptions[b.id] = `${i + 1}. ${b.enabled ? '' : '(off) '}${b.name} → ${b.mode}`; });
    const current = selectedBlock();
    const list = select(listOptions, current?.id ?? '', v => { settings.selectedBlockId = v; save(); renderChainUi(); });
    list.size = Math.min(Math.max(settings.blocks.length, 2), 8);

    const move = delta => {
        const i = settings.blocks.indexOf(current);
        const j = i + delta;
        if (!current || j < 0 || j >= settings.blocks.length) return;
        [settings.blocks[i], settings.blocks[j]] = [settings.blocks[j], settings.blocks[i]];
        save(); renderChainUi();
    };

    root.append(
        field('Blocks (run top to bottom)', list),
        el('div', { class: 'sp-ui-actions' }, [
            button('Add', () => { const b = createBlock(); settings.blocks.push(b); settings.selectedBlockId = b.id; save(); renderChainUi(); }),
            button('Duplicate', () => { if (!current) return; const b = normalizeBlock({ ...structuredClone(current), id: uid(), name: `${current.name} copy` }); settings.blocks.push(b); settings.selectedBlockId = b.id; save(); renderChainUi(); }),
            button('Up', () => move(-1)),
            button('Down', () => move(1)),
            button('Delete', async () => {
                if (!current) return;
                const ok = await ctx().callGenericPopup(`Delete block "${current.name}"?`, ctx().POPUP_TYPE.CONFIRM);
                if (!ok) return;
                settings.blocks = settings.blocks.filter(b => b !== current); settings.selectedBlockId = ''; save(); syncTools(); renderChainUi();
            }),
            button('Import', importBlocks),
            button('Export', () => exportBlocks(current ? [current] : [])),
        ]),
    );

    if (current) root.append(renderBlockEditor(current));

    root.append(
        el('div', { class: 'sp-ui-actions' }, [
            button('Run on last message', () => runChain(findLastIndex(isCharMessage), { manual: true }).catch(e => toastr.error(e.message))),
            el('input', { type: 'button', class: 'menu_button', value: 'Stop', id: 'sp_chain_stop', disabled: !running, on: { click: stopChain } }),
            button('Remove blocks from last message', () => removeBlocks(findLastIndex(isCharMessage)).catch(e => toastr.error(e.message))),
            button('Undo rewrite', () => undoRewrite(findLastIndex(isCharMessage)).catch(e => toastr.error(e.message))),
        ]),
        el('details', { class: 'sp-chain-help' }, [
            el('summary', { text: 'Macros and commands' }),
            el('ul', {}, MACRO_HELP.map(([m, d]) => el('li', {}, [el('code', { text: m }), document.createTextNode(` — ${d}`)]))),
            el('small', { text: 'Global (also in the main preset): {{lastOriginalMessage}}, {{topPos}}, {{bottomPos}}, {{captureChar}}, {{captureUser}}, {{chainHistory::N}}. Commands: /sp-chain [block=Name] [mesId], /sp-chain-stop, /sp-chain-clear, /sp-chain-undo. Message menu has a link button (Shift+click removes blocks).' }),
        ]),
    );
}

function renderBlockEditor(block) {
    const update = (key, value, rerender = false) => {
        block[key] = value;
        if (key === 'historyMode') block.includeInContext = value === 'result';
        save();
        if (key === 'exposeAsTool' || key === 'enabled' || key === 'name') syncTools();
        if (rerender) renderChainUi();
    };
    const wrap = el('div', { class: 'sp-chain-editor' });

    const nameInput = el('input', { class: 'text_pole', value: block.name, on: { change: () => update('name', nameInput.value.trim() || 'Block', true) } });

    wrap.append(
        field('Name', nameInput),
        checkbox('Enabled', '', block.enabled, v => update('enabled', v, true)),
        checkbox('Run automatically', 'Off: only via the message button or /sp-chain.', block.autoRun, v => update('autoRun', v)),
        field('Connection profile', select(getProfileOptions(), block.profileId, v => update('profileId', v)), 'Any Chat or Text Completion profile from Connection Manager.'),
        checkbox('Use the profile\'s completion preset', 'Sampling settings come from the preset saved in the profile.', block.usePreset, v => update('usePreset', v)),
        field('Mode', select(MODE_LABELS, block.mode, v => update('mode', v, true))),
    );

    if (block.mode !== BLOCK_MODES.SILENT) {
        const history = select({
            result: block.mode === BLOCK_MODES.REWRITE ? 'Переписать текст и историю модели' : 'В историю — результат',
            original: 'Только визуально — в историю только оригинал',
        }, block.historyMode, v => update('historyMode', v));
        history.id = 'sp_chain_history_mode';
        wrap.append(field('Chat history / История чата', history,
            'Со следующего запуска блока: «результат» отправляет переписанный пост или добавленный блок в будущие запросы. «Только оригинал» показывает изменения в чате, но в запросах оставляет исходный пост. Уже обработанные сообщения автоматически не пересчитываются.'));
    }

    if (block.mode === BLOCK_MODES.TOP || block.mode === BLOCK_MODES.BOTTOM) {
        wrap.append(
            field('Wrapper template', textarea(block.wrapper, 3, v => update('wrapper', v), '{{output}}'), 'Use {{output}}. Example: <details><summary>Notes</summary>\\n{{output}}\\n</details>'),
        );
    }

    // Prompt list
    const promptsBox = el('div', { class: 'sp-chain-prompts' });
    const renderPrompts = () => {
        promptsBox.replaceChildren();
        block.prompts.forEach((entry, index) => {
            const controls = el('div', { class: 'sp-ui-actions' }, [
                el('input', { type: 'checkbox', checked: entry.enabled, title: 'Enabled', on: { change: e => { entry.enabled = e.target.checked; save(); } } }),
                entry.type === 'history'
                    ? el('span', { text: 'Chat history (last N messages, real roles)' })
                    : select({ system: 'System', user: 'User', assistant: 'Assistant' }, entry.role, v => { entry.role = v; save(); }),
                button('↑', () => { if (index > 0) { [block.prompts[index - 1], block.prompts[index]] = [block.prompts[index], block.prompts[index - 1]]; save(); renderPrompts(); } }),
                button('↓', () => { if (index < block.prompts.length - 1) { [block.prompts[index + 1], block.prompts[index]] = [block.prompts[index], block.prompts[index + 1]]; save(); renderPrompts(); } }),
                button('✕', () => { block.prompts.splice(index, 1); save(); renderPrompts(); }),
            ]);
            const body = entry.type === 'history'
                ? el('input', { type: 'number', class: 'text_pole', min: 0, value: entry.count, on: { input: e => { entry.count = Math.max(0, Number(e.target.value) || 0); save(); } } })
                : textarea(entry.content, 4, v => { entry.content = v; save(); });
            promptsBox.append(el('div', { class: 'sp-chain-prompt' }, [controls, body]));
        });
    };
    renderPrompts();

    wrap.append(
        el('div', { class: 'sp-ui-field' }, [el('label', { text: 'Prompt (sent in this order)' }), promptsBox]),
        el('div', { class: 'sp-ui-actions' }, [
            button('+ System', () => { block.prompts.push({ role: 'system', enabled: true, content: '' }); save(); renderPrompts(); }),
            button('+ User', () => { block.prompts.push({ role: 'user', enabled: true, content: '' }); save(); renderPrompts(); }),
            button('+ Assistant', () => { block.prompts.push({ role: 'assistant', enabled: true, content: '' }); save(); renderPrompts(); }),
            button('+ Chat history', () => { block.prompts.push({ type: 'history', enabled: true, count: 6 }); save(); renderPrompts(); }),
        ]),
        field('Prefill mode', select(PREFILL_MODES, block.prefillMode, v => update('prefillMode', v)), 'Gemini 4 Argon rejects a trailing assistant message ("Prefilled model turns aren\'t supported"); use Function response there.'),
        field('Prefill (hidden)', textarea(block.prefill, 2, v => update('prefill', v)), 'Sent as the start of the reply, not added to the output.'),
        field('Start With (visible)', textarea(block.startWith, 2, v => update('startWith', v)), 'Sent as the start of the reply and kept at the start of the output.'),
        field('Max tokens', el('input', { type: 'number', class: 'text_pole', min: 1, value: block.maxTokens, on: { input: e => update('maxTokens', Math.max(1, Number(e.target.value) || 800)) } })),
        field('Temperature override', el('input', { type: 'number', class: 'text_pole', step: 0.05, value: block.temperature, placeholder: 'from preset', on: { input: e => update('temperature', e.target.value) } })),
        field('Run only if the message matches (regex)', el('input', { class: 'text_pole', value: block.condition, placeholder: 'empty = always', on: { change: e => update('condition', e.target.value) } })),
        field('Extract from output (regex, group 1)', el('input', { class: 'text_pole', value: block.extractRegex, placeholder: 'e.g. <block>(.*?)</block>', on: { change: e => update('extractRegex', e.target.value) } })),
        checkbox('Expose as a tool for the main model', 'Registers a function tool; the main model can call this helper during its reply. Needs function calling enabled in the main preset.', block.exposeAsTool, v => update('exposeAsTool', v, true)),
    );
    if (block.exposeAsTool) {
        wrap.append(field(`Tool description (${toolName(block)})`, textarea(block.toolDescription, 2, v => { block.toolDescription = v; save(); syncTools(); })));
    }

    wrap.append(el('div', { class: 'sp-ui-actions' }, [
        button('Preview prompt', () => previewPrompt(block)),
        button('Run this block on last message', () => runChain(findLastIndex(isCharMessage), { blockIds: [block.id], manual: true }).catch(e => toastr.error(e.message))),
    ]));

    return wrap;
}

async function previewPrompt(block) {
    const c = ctx();
    const messageId = findLastIndex(isCharMessage);
    let text;
    try {
        const message = c.chat[messageId] ?? { mes: '' };
        const req = buildBlockRequest(block, { messageId: Math.max(0, messageId), message, state: getStateReadOnly(message), block, prevOutput: '(previous block output)' });
        text = JSON.stringify({ messages: req.messages, overridePayload: req.overridePayload }, null, 2);
    } catch (error) {
        text = `Error: ${error.message}`;
    }
    const pre = el('pre', { text, style: 'text-align:left; white-space:pre-wrap; max-height:65vh; overflow:auto;' });
    await c.callGenericPopup(pre, c.POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

function exportBlocks(blocks) {
    const data = JSON.stringify({ type: 'silly-prefill-blocks', version: 1, blocks: blocks.map(b => ({ ...b, profileId: '' })) }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = el('a', { href: url, download: `${blocks[0]?.name ?? 'blocks'}.sp-blocks.json` });
    link.click();
    URL.revokeObjectURL(url);
}

function importBlocks() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
        try {
            const data = JSON.parse(await input.files[0].text());
            const blocks = (Array.isArray(data?.blocks) ? data.blocks : [data]).map(b => normalizeBlock({ ...b, id: uid() }));
            chainSettings().blocks.push(...blocks);
            chainSettings().selectedBlockId = blocks[0]?.id ?? '';
            save(); renderChainUi();
            toastr.success(`Imported ${blocks.length} block(s). Select a connection profile for each.`);
        } catch (error) {
            toastr.error(`Import failed: ${error.message}`);
        }
    });
    input.click();
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

export function initChain(hostApi) {
    api = hostApi;
    const c = ctx();
    registerGlobalMacros();
    registerCommands();
    c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    c.eventSource.on(c.eventTypes.MESSAGE_EDITED, onMessageEdited);
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { stopChain(); addMessageButton(); });
    c.eventSource.on(c.eventTypes.APP_READY, () => { addMessageButton(); syncTools(); });
    addMessageButton();
    syncTools();
}

// Exposed for tests.
export const __test = { getState, composeParts, buildRunMacros, postProcess, joinParts, applyState, onMessageEdited };
