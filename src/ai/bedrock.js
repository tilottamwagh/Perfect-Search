require('dotenv').config();
const { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SYSTEM_PROMPT, CASE_ANALYSIS_SYSTEM_PROMPT, selectSources, buildUserMessage, buildCaseAnalysisText } = require('./prompt');
const logger = require('../utils/logger');

// AWS Bedrock — unified Converse API supporting Anthropic Claude, Amazon Nova,
// Meta Llama, Mistral and more. Credentials are stored as a JSON blob:
// { accessKeyId, secretAccessKey, sessionToken?, region }.
// SSO/temporary credentials (ASIA* keys) also need sessionToken.

const DEFAULT_MODEL = process.env.OMNISEARCH_BEDROCK_MODEL || 'amazon.nova-lite-v1:0';

const MODELS = [
    // Anthropic Claude via Bedrock (same model, AWS billing)
    { id: 'anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5 — most capable (Anthropic via Bedrock)', tier: 'premium', supportsWeb: false },
    { id: 'anthropic.claude-sonnet-4-5-20251101-v1:0', label: 'Claude Sonnet 4.5 — fast & smart (Anthropic via Bedrock)', tier: 'standard', supportsWeb: false },
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
    keyPrefix: 'AKIA',
    keyHelp: 'Paste your AWS credentials as JSON: { "accessKeyId": "AKIA...", "secretAccessKey": "...", "sessionToken": "..." (SSO only), "region": "us-east-1" }. Enable models at AWS Console → Bedrock → Model access.',
    pricing: 'pay-per-token · varies by model',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    supportsWeb: false,
    // Signals to LoginPanel to render the multi-field credential UI
    credentialFormat: 'aws-bedrock',
};

// Parse the JSON credential blob stored as the "API key".
function parseCreds(apiKey) {
    try {
        const c = typeof apiKey === 'string' ? JSON.parse(apiKey) : apiKey;
        if (!c || !c.accessKeyId || !c.secretAccessKey) return null;
        return c;
    } catch (_) { return null; }
}

function makeClient(creds) {
    const cfg = {
        region: creds.region || 'us-east-1',
        credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
        },
    };
    if (creds.sessionToken) cfg.credentials.sessionToken = creds.sessionToken;
    return new BedrockRuntimeClient(cfg);
}

// Build Converse API messages from our internal result objects.
function buildConverseMessages(systemText, userText) {
    return {
        system: [{ text: systemText }],
        messages: [{ role: 'user', content: [{ text: userText }] }],
    };
}

async function testKey(apiKey) {
    const creds = parseCreds(apiKey);
    if (!creds) return { ok: false, error: 'Invalid JSON — paste as: {"accessKeyId":"...","secretAccessKey":"...","region":"us-east-1"}' };
    try {
        const client = makeClient(creds);
        // Minimal converse call — 1 token max, cheapest model
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
        if (/AccessDenied|not authorized|UnauthorizedClient/i.test(msg)) return { ok: false, error: 'Access denied — your IAM role needs bedrock:InvokeModel permission. Check AWS Console → Bedrock → Model access.' };
        if (/ResourceNotFoundException|not found/i.test(msg)) return { ok: false, error: 'Model not enabled — go to AWS Console → Bedrock → Model access and enable Amazon Nova Micro.' };
        return { ok: false, error: msg.slice(0, 200) };
    }
}

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt, picked: prePicked }) {
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid AWS credentials JSON');
    const picked = Array.isArray(prePicked) ? prePicked : selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    const sysText = (systemPrompt && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[bedrock:${modelId}] sources=${picked.length} prompt=${userText.length} chars`);
    const startedAt = Date.now();

    const client = makeClient(creds);
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

// Non-streaming chat for intent classification and query extraction.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid AWS credentials JSON');
    const modelId = model || DEFAULT_MODEL;
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

// ServiceNow case analysis — text-only (images skipped for non-vision models;
// Claude models on Bedrock do support vision but we skip for simplicity).
async function analyzeCase({ caseBundle, kbResults, apiKey, onChunk, model }) {
    const creds = parseCreds(apiKey);
    if (!creds) throw new Error('Invalid AWS credentials JSON');
    const modelId = model || DEFAULT_MODEL;
    let text = buildCaseAnalysisText(caseBundle, kbResults);
    const imageCount = Array.isArray(caseBundle?.images) ? caseBundle.images.length : 0;
    if (imageCount > 0) {
        text += `\n\n(NOTE: ${imageCount} screenshot(s) attached — image analysis not enabled for this model. Analyze from text above.)`;
    }

    logger.info('Phase 7', `[bedrock:${modelId}] analyzeCase prompt=${text.length} chars, kb=${(kbResults || []).length}`);
    const startedAt = Date.now();

    const client = makeClient(creds);
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

module.exports = { META, parseCreds, testKey, synthesize, synthesizeWithWeb, chat, analyzeCase };
