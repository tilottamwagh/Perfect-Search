require('dotenv').config();
const { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
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
    keyHelp: 'Paste a Bedrock API key (bedrock-api-key-…) from AWS Console → Bedrock → API keys. Short-term keys last 12 h; long-term keys up to 1 year. Or paste IAM credentials as JSON: {"accessKeyId":"AKIA…","secretAccessKey":"…","region":"us-east-1"}.',
    pricing: 'pay-per-token · varies by model',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    supportsWeb: false,
    credentialFormat: 'aws-bedrock',
};

// ─── credential detection ────────────────────────────────────────────────────

function isApiKey(key) {
    return typeof key === 'string' && key.startsWith('bedrock-api-key-');
}

// Extract region from the presigned-URL payload embedded in a Bedrock API key.
function extractRegionFromApiKey(apiKey) {
    try {
        const payload = Buffer.from(apiKey.slice('bedrock-api-key-'.length), 'base64').toString('utf8');
        const m = payload.match(/[%2F/]([a-z]+-[a-z]+-\d)(?:%2F|\/)bedrock/i);
        return m ? m[1] : 'us-east-1';
    } catch (_) { return 'us-east-1'; }
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
// API keys use { token } config → SDK emits Authorization: Bearer instead of SigV4.
// IAM JSON uses { credentials } config → SDK uses SigV4.

function makeClient(apiKey) {
    if (isApiKey(apiKey)) {
        const region = extractRegionFromApiKey(apiKey);
        return new BedrockRuntimeClient({ region, token: { token: apiKey } });
    }
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid credential — paste a Bedrock API key (bedrock-api-key-…) or IAM JSON {"accessKeyId":"…","secretAccessKey":"…","region":"us-east-1"}');
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
        return { ok: false, error: 'Invalid credential — paste a Bedrock API key (bedrock-api-key-…) or IAM JSON {"accessKeyId":"…","secretAccessKey":"…","region":"us-east-1"}' };
    }
    try {
        const client = makeClient(apiKey);
        const cmd = new ConverseCommand({
            modelId: 'amazon.nova-micro-v1:0',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
            inferenceConfig: { maxTokens: 1 },
        });
        const resp = await client.send(cmd);
        const ok = resp.$metadata?.httpStatusCode === 200;
        const region = isApiKey(apiKey) ? extractRegionFromApiKey(apiKey) : (parseCreds(apiKey)?.region || 'us-east-1');
        return { ok, model: region, error: ok ? undefined : 'Unexpected response from Bedrock' };
    } catch (err) {
        const msg = (err.cause?.message || err.message || String(err)).slice(0, 300);
        if (/ExpiredToken|expired|TokenExpired/i.test(msg)) return { ok: false, error: 'Bedrock key or credentials have expired. Generate a new API key from AWS Console → Bedrock → API keys.' };
        if (/AccessDenied|not authorized|UnauthorizedClient|InvalidSignature/i.test(msg)) return { ok: false, error: 'Access denied — your key/role needs bedrock:InvokeModel permission.' };
        if (/ResourceNotFoundException|not found/i.test(msg)) return { ok: false, error: 'Model not available — enable Amazon Nova Micro in AWS Console → Bedrock → Model access (or check your region).' };
        return { ok: false, error: msg };
    }
}

// ─── synthesize ──────────────────────────────────────────────────────────────

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked }) {
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;
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

    const resp = await client.send(cmd);
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

async function synthesizeWithWeb() {
    throw new Error('WEB_NOT_SUPPORTED: AWS Bedrock does not expose a web-search tool. Switch to Anthropic Claude or Google Gemini in Settings to use Web Research.');
}

// ─── chat (non-streaming, for intent/query extraction) ───────────────────────

async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    const client = makeClient(apiKey);
    const cmd = new ConverseCommand({
        modelId,
        system: [{ text: systemPrompt }],
        messages: [{ role: 'user', content: [{ text: userPrompt }] }],
        inferenceConfig: { maxTokens, temperature: 0.1 },
    });
    const resp = await client.send(cmd);
    return resp.output?.message?.content?.[0]?.text || '';
}

// ─── analyzeCase ─────────────────────────────────────────────────────────────

async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
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

    const resp = await client.send(cmd);
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

module.exports = { META, parseCreds, isApiKey, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase };
