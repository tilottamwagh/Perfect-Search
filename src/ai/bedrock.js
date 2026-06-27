require('dotenv').config();
const { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// AWS Bedrock — two authentication modes, same AWS SDK code path:
//
// 1. Bedrock API key  (bedrock-api-key-…)
//    Generated at AWS Console → Bedrock → API keys. Short-term keys last up
//    to 12 hours; long-term keys up to 1 year. The key encodes the region and
//    temporary AWS credentials as a presigned Bearer token. The AWS SDK
//    accepts it via { token: { token: '...' } } which emits
//    Authorization: Bearer <key> instead of Sig V4 on the Converse API.
//
// 2. IAM JSON credentials  ({ accessKeyId, secretAccessKey, sessionToken?, region })
//    For permanent IAM user keys (AKIA*) or SSO temp keys (ASIA*).

const DEFAULT_MODEL = process.env.OMNISEARCH_BEDROCK_MODEL || 'amazon.nova-lite-v1:0';

// In non-US regions, Amazon Nova (and Titan) models must be invoked via a
// cross-region inference profile — e.g. ap.amazon.nova-micro-v1:0 — because
// on-demand throughput for the bare model ID is only available in us-* regions.
const INFERENCE_PROFILE_MODELS = /^amazon\.(nova|titan)/i;

function getGeoPrefix(region) {
    if (region.startsWith('eu-')) return 'eu';
    if (region.startsWith('ap-')) return 'ap';
    return 'us'; // us-* and all others
}

function resolveModelId(modelId, region) {
    if (!INFERENCE_PROFILE_MODELS.test(modelId)) return modelId;
    return `${getGeoPrefix(region)}.${modelId}`;
}

const MODELS = [
    // Anthropic Claude via Bedrock
    { id: 'anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5 — most capable', tier: 'premium', supportsWeb: false },
    { id: 'anthropic.claude-sonnet-4-5-20251101-v1:0', label: 'Claude Sonnet 4.5 — fast & smart', tier: 'standard', supportsWeb: false },
    { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', label: 'Claude 3.5 Sonnet v2 — recommended', tier: 'standard', supportsWeb: false },
    { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', label: 'Claude 3.5 Haiku — fast & cheap', tier: 'fast', supportsWeb: false },
    { id: 'anthropic.claude-3-haiku-20240307-v1:0', label: 'Claude 3 Haiku — cheapest Claude', tier: 'fast', supportsWeb: false },
    // Amazon Nova
    { id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro — balanced, multimodal', tier: 'premium', supportsWeb: false },
    { id: 'amazon.nova-lite-v1:0', label: 'Amazon Nova Lite — fast & cheap (default)', tier: 'standard', supportsWeb: false },
    { id: 'amazon.nova-micro-v1:0', label: 'Amazon Nova Micro — text-only, cheapest', tier: 'fast', supportsWeb: false },
    // Meta Llama
    { id: 'meta.llama3-3-70b-instruct-v1:0', label: 'Llama 3.3 70B — strong open model', tier: 'standard', supportsWeb: false },
    { id: 'meta.llama3-1-8b-instruct-v1:0', label: 'Llama 3.1 8B — fastest Llama', tier: 'fast', supportsWeb: false },
    // Mistral
    { id: 'mistral.mistral-large-2402-v1:0', label: 'Mistral Large — strong European model', tier: 'premium', supportsWeb: false },
    { id: 'mistral.mistral-small-2402-v1:0', label: 'Mistral Small — cheap & fast', tier: 'fast', supportsWeb: false },
];

const META = {
    id: 'bedrock',
    name: 'AWS Bedrock',
    color: 'orange',
    keyPrefix: 'bedrock-api-key-',
    keyHelp: 'Paste a Bedrock API key from AWS Console → Bedrock → API keys.\n• Short-term key: bedrock-api-key-… (region auto-detected, lasts 12 h)\n• Long-term key: ABSK… (lasts up to 1 year) — if outside us-east-1, append your region: ABSK…|ap-south-1\n• Or paste IAM JSON: {"accessKeyId":"AKIA…","secretAccessKey":"…","region":"us-east-1"}',
    pricing: 'pay-per-token · varies by model',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // No native web search on Bedrock, but shared DuckDuckGo fallback works.
    supportsWeb: true,
    credentialFormat: 'aws-bedrock',
};

// ─── credential detection ────────────────────────────────────────────────────

// Accepts short-term keys (bedrock-api-key-…) and long-term keys (ABSK…).
// Long-term keys don't encode the region, so append |region if not us-east-1:
//   e.g.  ABSK0abc…xyz|ap-south-1
function isApiKey(key) {
    if (typeof key !== 'string') return false;
    const raw = key.includes('|') ? key.split('|')[0].trim() : key;
    return raw.startsWith('bedrock-api-key-') || raw.startsWith('ABSK');
}

// Strip the optional |region suffix to get the raw Bearer token value.
function getBearerToken(apiKey) {
    return apiKey.includes('|') ? apiKey.split('|')[0].trim() : apiKey;
}

// Extract region from the presigned-URL payload embedded in a Bedrock API key.
function extractRegionFromApiKey(apiKey) {
    // Explicit region suffix: ABSK...|ap-south-1
    if (apiKey.includes('|')) {
        const region = apiKey.split('|')[1]?.trim();
        if (region && /^[a-z]+-[a-z]+-\d+$/.test(region)) return region;
    }
    // Short-term keys encode region in base64 presigned-URL payload.
    if (apiKey.startsWith('bedrock-api-key-')) {
        try {
            const payload = Buffer.from(apiKey.slice('bedrock-api-key-'.length), 'base64').toString('utf8');
            // Match %2F or / as a complete unit (not character-by-character) before the region.
            const m = payload.match(/(?:%2F|\/)([a-z]+-[a-z]+-\d+)(?:%2F|\/)bedrock/i);
            return m ? m[1].toLowerCase() : 'us-east-1';
        } catch (_) { return 'us-east-1'; }
    }
    // Long-term ABSK keys without explicit |region → default us-east-1.
    return 'us-east-1';
}

function parseCreds(apiKey) {
    try {
        const c = typeof apiKey === 'string' ? JSON.parse(apiKey) : apiKey;
        if (!c || !c.accessKeyId || !c.secretAccessKey) return null;
        return c;
    } catch (_) { return null; }
}

// ─── client factory ──────────────────────────────────────────────────────────
// Both auth modes use the same AWS SDK ConverseCommand/ConverseStreamCommand.
//
// API keys: the SDK { token } option does NOT bypass SigV4 for BedrockRuntime.
// Instead we use a custom NodeHttpHandler that intercepts the outgoing request
// and replaces the SigV4 Authorization header with "Bearer <key>" — along with
// stripping the SigV4-specific amz headers that would confuse the server.
// Dummy credentials satisfy the SDK's internal validation; the server never
// sees them because our handler overwrites the header before the TCP write.
//
// IAM JSON: standard SigV4 path via { credentials } config.

class BearerTokenHandler {
    constructor(token) {
        this._token = token;
        this._inner = new NodeHttpHandler({ connectionTimeout: 10000, requestTimeout: 60000 });
    }
    async handle(request, options) {
        request.headers['authorization'] = `Bearer ${this._token}`;
        delete request.headers['x-amz-date'];
        delete request.headers['x-amz-security-token'];
        delete request.headers['x-amz-content-sha256'];
        return this._inner.handle(request, options);
    }
    updateHttpClientConfig(k, v) { return this._inner.updateHttpClientConfig(k, v); }
    httpHandlerConfigs() { return this._inner.httpHandlerConfigs(); }
}

function makeClient(apiKey) {
    if (isApiKey(apiKey)) {
        const region = extractRegionFromApiKey(apiKey);
        const token = getBearerToken(apiKey);
        return new BedrockRuntimeClient({
            region,
            credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' },
            requestHandler: new BearerTokenHandler(token),
        });
    }
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid credential — paste a Bedrock API key (bedrock-api-key-… or ABSK…), or IAM JSON {"accessKeyId":"…","secretAccessKey":"…","region":"us-east-1"}');
    const cfg = {
        region: creds.region || 'us-east-1',
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    };
    if (creds.sessionToken) cfg.credentials.sessionToken = creds.sessionToken;
    return new BedrockRuntimeClient(cfg);
}

// ─── testKey ─────────────────────────────────────────────────────────────────

async function testKey(apiKey) {
    if (!isApiKey(apiKey) && !parseCreds(apiKey)) {
        return { ok: false, error: 'Invalid credential — paste a Bedrock API key (bedrock-api-key-… or ABSK…), or IAM JSON {"accessKeyId":"…","secretAccessKey":"…","region":"us-east-1"}. For long-term ABSK keys outside us-east-1, append your region: ABSK…|ap-south-1' };
    }
    const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
    // Try models in order — not all models are available in every region.
    // ap-south-1 (Mumbai) and similar fringe regions may not have Nova inference profiles.
    const candidates = [
        resolveModelId('amazon.nova-micro-v1:0', region),
        'anthropic.claude-3-haiku-20240307-v1:0',
        'amazon.titan-text-lite-v1',
    ];
    let lastErr = '';
    for (const modelId of candidates) {
        try {
            const client = makeClient(apiKey);
            const cmd = new ConverseCommand({
                modelId,
                messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
                inferenceConfig: { maxTokens: 1 },
            });
            const resp = await client.send(cmd);
            if (resp.$metadata?.httpStatusCode === 200) return { ok: true, model: region };
        } catch (err) {
            const msg = (err.cause?.message || err.message || String(err));
            if (/ExpiredToken|expired|TokenExpired/i.test(msg)) return { ok: false, error: 'Bedrock key or credentials have expired. Generate a new API key from AWS Console → Bedrock → API keys.' };
            if (/AccessDenied|not authorized|UnauthorizedClient|InvalidSignature/i.test(msg)) return { ok: false, error: 'Access denied — your key/role needs bedrock:InvokeModel permission.' };
            // Rate-limited = key is valid, quota temporarily exhausted.
            if (/too many tokens|ThrottlingException|throttl|rate.?limit|quota/i.test(msg)) return { ok: true, model: region, warning: 'Key is valid but your account has hit its daily token quota. Usage will resume when the quota resets (usually midnight UTC).' };
            // Model unavailable, EOL, or needs form — try the next candidate.
            if (/invalid.*model|model.*invalid|ValidationException|not supported|use case|model access|ModelNotReady|EnabledModels|not enabled|access.*model|model.*access|end of (its )?life|deprecated/i.test(msg)) { lastErr = msg; continue; }
            return { ok: false, error: msg.slice(0, 300) };
        }
    }
    // All candidates failed — region likely has no supported models.
    const hint = region !== 'us-east-1'
        ? ` Try removing |${region} from your key to use the us-east-1 endpoint instead.`
        : '';
    return { ok: false, error: `No compatible models found in region ${region}.${hint}` };
}

// ─── shared error translator ─────────────────────────────────────────────────

function translateBedrockError(err) {
    const msg = (err.cause?.message || err.message || String(err));
    if (/too many tokens|ThrottlingException|throttl|rate.?limit|quota/i.test(msg))
        throw new Error('AWS Bedrock daily token quota exhausted. Quota resets at midnight UTC — or switch to another AI provider in Settings.');
    if (/ExpiredToken|expired|TokenExpired/i.test(msg))
        throw new Error('Bedrock key has expired. Generate a new API key from AWS Console → Bedrock → API keys.');
    if (/AccessDenied|not authorized/i.test(msg))
        throw new Error('Access denied — your key/role needs bedrock:InvokeModel permission.');
    throw err;
}

// ─── synthesize ──────────────────────────────────────────────────────────────

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked }) {
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
    const modelId = resolveModelId(model || DEFAULT_MODEL, region);
    const userText = buildUserMessage(query, picked);
    const sysText = (systemPrompt && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[bedrock:${modelId}] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    const client = makeClient(apiKey);
    const cmd = new ConverseStreamCommand({
        modelId,
        system: [{ text: sysText }],
        messages: [{ role: 'user', content: [{ text: userText }] }],
        inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
    });

    let resp;
    try { resp = await client.send(cmd); } catch (err) { translateBedrockError(err); }
    let fullText = '';
    let usage = null;
    for await (const event of resp.stream) {
        if (event.contentBlockDelta?.delta?.text) {
            const delta = event.contentBlockDelta.delta.text;
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (event.metadata?.usage) usage = event.metadata.usage;
    }

    const elapsed = Date.now() - startedAt;
    let finalUsage;
    if (usage && (usage.inputTokens || usage.outputTokens)) {
        finalUsage = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) };
    } else {
        const inEst = Math.ceil((sysText.length + userText.length) / 4);
        const outEst = Math.ceil(fullText.length / 4);
        finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
    }
    logger.success('Phase 6', `[bedrock:${modelId}] done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, picked, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

// Bedrock has no native web search — use the shared DuckDuckGo fallback.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const { webResearch } = require('./webSearch');
    return webResearch({ adapter: module.exports, query, apiKey, model: model || DEFAULT_MODEL, onChunk });
}

// ─── chat (non-streaming, for intent/query extraction) ───────────────────────

async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
    const modelId = resolveModelId(model || DEFAULT_MODEL, region);
    const client = makeClient(apiKey);
    const cmd = new ConverseCommand({
        modelId,
        system: [{ text: systemPrompt }],
        messages: [{ role: 'user', content: [{ text: userPrompt }] }],
        inferenceConfig: { maxTokens, temperature: 0.1 },
    });
    let resp;
    try { resp = await client.send(cmd); } catch (err) { translateBedrockError(err); }
    return resp.output?.message?.content?.[0]?.text || '';
}

// ─── analyzeCase ─────────────────────────────────────────────────────────────

async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
    const modelId = resolveModelId(model || DEFAULT_MODEL, region);
    let text = buildCaseAnalysisText(caseBundle, kbResults);
    const imageCount = Array.isArray(caseBundle?.images) ? caseBundle.images.length : 0;
    if (imageCount > 0) {
        text += `\n\n(NOTE: ${imageCount} screenshot(s) attached — image analysis not enabled for this model.)`;
    }
    logger.info('Phase 7', `[bedrock:${modelId}] analyzeCase prompt=${text.length} chars, kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    const client = makeClient(apiKey);
    const cmd = new ConverseStreamCommand({
        modelId,
        system: [{ text: CASE_ANALYSIS_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text }] }],
        inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
    });

    let resp;
    try { resp = await client.send(cmd); } catch (err) { translateBedrockError(err); }
    let fullText = '';
    let usage = null;
    for await (const event of resp.stream) {
        if (event.contentBlockDelta?.delta?.text) {
            const delta = event.contentBlockDelta.delta.text;
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (event.metadata?.usage) usage = event.metadata.usage;
    }

    const elapsed = Date.now() - startedAt;
    let finalUsage;
    if (usage && (usage.inputTokens || usage.outputTokens)) {
        finalUsage = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) };
    } else {
        const inEst = Math.ceil(text.length / 4);
        const outEst = Math.ceil(fullText.length / 4);
        finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
    }
    logger.success('Phase 7', `[bedrock:${modelId}] analyzeCase done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

// Multi-turn streaming chat for "Ask AI Expert" using Bedrock's Converse API.
// The Converse format is { role, content: [{text} | {image:{format,source:{bytes}}}] }
// — we translate from the unified OpenAI-shaped UI message history.
async function expertChat({ messages, systemPrompt, apiKey, onChunk, model }) {
    const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
    const modelId = resolveModelId(model || DEFAULT_MODEL, region);
    const client = makeClient(apiKey);

    const converseMessages = (messages || []).map((m) => {
        if (typeof m.content === 'string') {
            return { role: m.role, content: [{ text: m.content }] };
        }
        const blocks = (m.content || []).map((b) => {
            if (b.type === 'text') return { text: b.text };
            if (b.type === 'image_url' && b.image_url?.url?.startsWith('data:')) {
                const [meta, data] = b.image_url.url.split(',');
                const mime = (meta.match(/data:([^;]+)/) || [null, 'image/png'])[1];
                const format = mime.split('/')[1] || 'png';
                return { image: { format, source: { bytes: Buffer.from(data, 'base64') } } };
            }
            return null;
        }).filter(Boolean);
        return { role: m.role, content: blocks };
    });

    const cmd = new ConverseStreamCommand({
        modelId,
        system: [{ text: systemPrompt || 'You are a helpful assistant.' }],
        messages: converseMessages,
        inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
    });

    const startedAt = Date.now();
    let resp;
    try { resp = await client.send(cmd); } catch (err) { translateBedrockError(err); }
    let fullText = '';
    let usage = null;
    for await (const event of resp.stream) {
        if (event.contentBlockDelta?.delta?.text) {
            const delta = event.contentBlockDelta.delta.text;
            fullText += delta;
            if (onChunk) try { onChunk(delta); } catch (_) {}
        }
        if (event.metadata?.usage) usage = event.metadata.usage;
    }
    const finalUsage = usage
        ? { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) }
        : null;
    return { text: fullText, usage: finalUsage, model: modelId, elapsedMs: Date.now() - startedAt };
}

module.exports = {
    META, parseCreds, isApiKey, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase, expertChat,
    // Internal helpers exposed for the expert agent (which needs the same
    // multi-format auth + cross-region-profile resolution).
    _makeClient: makeClient,
    _resolveModelId: resolveModelId,
    _extractRegion: extractRegionFromApiKey,
};
