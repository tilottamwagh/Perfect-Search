require('dotenv').config();
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// AWS Bedrock — two authentication modes:
//
// 1. Bedrock API key  (bedrock-api-key-…)  ← recommended, simple
//    Generated from AWS Console → Bedrock → API keys.
//    Short-term keys last up to 12 hours; long-term keys up to 1 year.
//    Uses Bedrock's OpenAI-compatible endpoint with Bearer auth.
//    The region and credentials are encoded inside the key itself.
//
// 2. IAM JSON credentials  ({ accessKeyId, secretAccessKey, sessionToken?, region })
//    For permanent IAM user keys (AKIA*) or SSO temp keys (ASIA*).
//    Uses @aws-sdk Converse API with Sig V4 signing.

const { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

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
    keyHelp: 'Paste a Bedrock API key (bedrock-api-key-…) from AWS Console → Bedrock → API keys. Short-term keys last 12 h; long-term keys last up to 1 year. Alternatively, paste IAM credentials as JSON: {"accessKeyId":"AKIA…","secretAccessKey":"…","region":"us-east-1"}.',
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
        // Credential parameter looks like: %2Fus-east-1%2Fbedrock%2F or /us-east-1/bedrock/
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

// ─── IAM path helpers (AWS SDK Converse API) ─────────────────────────────────

function makeClient(creds) {
    const cfg = {
        region: creds.region || 'us-east-1',
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    };
    if (creds.sessionToken) cfg.credentials.sessionToken = creds.sessionToken;
    return new BedrockRuntimeClient(cfg);
}

// ─── API-key path helpers (OpenAI-compatible endpoint) ───────────────────────

function apiKeyBaseUrl(apiKey) {
    const region = extractRegionFromApiKey(apiKey);
    return `https://bedrock.${region}.amazonaws.com/v1`;
}

async function* sseLines(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const raw of block.split('\n')) {
                if (!raw.startsWith('data:')) continue;
                const payload = raw.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try { yield JSON.parse(payload); } catch (_) {}
            }
        }
    }
}

async function apiKeyStreamChat(apiKey, modelId, messages, maxTokens, temperature, onChunk) {
    const url = `${apiKeyBaseUrl(apiKey)}/chat/completions`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelId, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature, messages }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Bedrock API error ${resp.status}: ${body.slice(0, 300)}`);
    }
    let fullText = '';
    let usage = null;
    for await (const ev of sseLines(resp)) {
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) { fullText += delta; if (onChunk) try { onChunk(delta); } catch (_) {} }
        if (ev.usage) usage = ev.usage;
    }
    return { fullText, usage };
}

async function apiKeyChat(apiKey, modelId, messages, maxTokens, temperature) {
    const url = `${apiKeyBaseUrl(apiKey)}/chat/completions`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelId, max_tokens: maxTokens, temperature, messages }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Bedrock API error ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

// ─── testKey ─────────────────────────────────────────────────────────────────

async function testKey(apiKey) {
    if (isApiKey(apiKey)) {
        try {
            const text = await apiKeyChat(apiKey, 'amazon.nova-micro-v1:0',
                [{ role: 'user', content: 'Hi' }], 1, 0.1);
            return { ok: true, model: extractRegionFromApiKey(apiKey) };
        } catch (err) {
            const msg = err.message || String(err);
            if (/401|unauthorized|Unauthorized/i.test(msg)) return { ok: false, error: 'Bedrock API key rejected — it may have expired. Generate a new key from AWS Console → Bedrock → API keys.' };
            if (/403|forbidden|AccessDenied/i.test(msg)) return { ok: false, error: 'Access denied — your key does not have bedrock:InvokeModel permission.' };
            return { ok: false, error: msg.slice(0, 200) };
        }
    }
    // IAM credentials path
    const creds = parseCreds(apiKey);
    if (!creds) return { ok: false, error: 'Invalid credential — paste a Bedrock API key (bedrock-api-key-…) or IAM JSON {"accessKeyId":"…","secretAccessKey":"…","region":"us-east-1"}' };
    try {
        const client = makeClient(creds);
        const cmd = new ConverseCommand({
            modelId: 'amazon.nova-micro-v1:0',
            messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
            inferenceConfig: { maxTokens: 1 },
        });
        const resp = await client.send(cmd);
        const ok = resp.$metadata?.httpStatusCode === 200;
        return { ok, model: creds.region || 'us-east-1', error: ok ? undefined : 'Unexpected response from Bedrock' };
    } catch (err) {
        const msg = err.message || String(err);
        if (/ExpiredToken|expired/i.test(msg)) return { ok: false, error: 'AWS credentials have expired. Refresh your SSO session and paste new credentials.' };
        if (/AccessDenied|not authorized/i.test(msg)) return { ok: false, error: 'Access denied — IAM role needs bedrock:InvokeModel permission.' };
        if (/ResourceNotFoundException|not found/i.test(msg)) return { ok: false, error: 'Model not enabled — enable Amazon Nova Micro in AWS Console → Bedrock → Model access.' };
        return { ok: false, error: msg.slice(0, 200) };
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

    let fullText, finalUsage;

    if (isApiKey(apiKey)) {
        const messages = [{ role: 'user', content: userText }];
        // System prompt via system role message
        const allMessages = [{ role: 'system', content: sysText }, ...messages];
        const { fullText: ft, usage } = await apiKeyStreamChat(apiKey, modelId, allMessages, 4096, 0.4, onChunk);
        fullText = ft;
        if (usage) {
            finalUsage = { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 };
        } else {
            const inEst = Math.ceil((sysText.length + userText.length) / 4);
            const outEst = Math.ceil(fullText.length / 4);
            finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
        }
    } else {
        const creds = parseCreds(apiKey);
        if (!creds) throw new Error('Invalid AWS credentials');
        const client = makeClient(creds);
        const cmd = new ConverseStreamCommand({
            modelId,
            system: [{ text: sysText }],
            messages: [{ role: 'user', content: [{ text: userText }] }],
            inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
        });
        const resp = await client.send(cmd);
        fullText = '';
        let usage = null;
        for await (const event of resp.stream) {
            if (event.contentBlockDelta?.delta?.text) {
                const delta = event.contentBlockDelta.delta.text;
                fullText += delta;
                if (onChunk) try { onChunk(delta); } catch (_) {}
            }
            if (event.metadata?.usage) usage = event.metadata.usage;
        }
        if (usage && (usage.inputTokens || usage.outputTokens)) {
            finalUsage = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) };
        } else {
            const inEst = Math.ceil((sysText.length + userText.length) / 4);
            const outEst = Math.ceil(fullText.length / 4);
            finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
        }
    }

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[bedrock:${modelId}] done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, picked, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

async function synthesizeWithWeb() {
    throw new Error('WEB_NOT_SUPPORTED: AWS Bedrock does not expose a web-search tool. Switch to Anthropic Claude or Google Gemini in Settings to use Web Research.');
}

// ─── chat (non-streaming, for intent/query extraction) ───────────────────────

async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    if (isApiKey(apiKey)) {
        return await apiKeyChat(apiKey, modelId,
            [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            maxTokens, 0.1);
    }
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid AWS credentials JSON');
    const client = makeClient(creds);
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

    let fullText, finalUsage;

    if (isApiKey(apiKey)) {
        const messages = [{ role: 'system', content: CASE_ANALYSIS_SYSTEM_PROMPT }, { role: 'user', content: text }];
        const { fullText: ft, usage } = await apiKeyStreamChat(apiKey, modelId, messages, 4096, 0.3, onChunk);
        fullText = ft;
        if (usage) {
            finalUsage = { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 };
        } else {
            const inEst = Math.ceil(text.length / 4);
            const outEst = Math.ceil(fullText.length / 4);
            finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
        }
    } else {
        const creds = parseCreds(apiKey);
        if (!creds) throw new Error('Invalid AWS credentials JSON');
        const client = makeClient(creds);
        const cmd = new ConverseStreamCommand({
            modelId,
            system: [{ text: CASE_ANALYSIS_SYSTEM_PROMPT }],
            messages: [{ role: 'user', content: [{ text }] }],
            inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
        });
        const resp = await client.send(cmd);
        fullText = '';
        let usage = null;
        for await (const event of resp.stream) {
            if (event.contentBlockDelta?.delta?.text) {
                const delta = event.contentBlockDelta.delta.text;
                fullText += delta;
                if (onChunk) try { onChunk(delta); } catch (_) {}
            }
            if (event.metadata?.usage) usage = event.metadata.usage;
        }
        if (usage && (usage.inputTokens || usage.outputTokens)) {
            finalUsage = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) };
        } else {
            const inEst = Math.ceil(text.length / 4);
            const outEst = Math.ceil(fullText.length / 4);
            finalUsage = { input_tokens: inEst, output_tokens: outEst, total_tokens: inEst + outEst, estimated: true };
        }
    }

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 7', `[bedrock:${modelId}] analyzeCase done in ${elapsed}ms · in=${finalUsage.input_tokens} out=${finalUsage.output_tokens}`);
    return { text: fullText, usage: finalUsage, model: modelId, elapsedMs: elapsed };
}

module.exports = { META, parseCreds, isApiKey, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase };
