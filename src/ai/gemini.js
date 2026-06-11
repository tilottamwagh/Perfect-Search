require('dotenv').config();
const { SYSTEM_PROMPT, selectSources, buildUserMessage } = require('./prompt');
const logger = require('../utils/logger');

// `gemini-2.5-flash` is the current default — fast, free tier, and supports
// Google Search grounding. The older `gemini-2.0-flash` alias was retired by
// Google in 2026; users hit "no longer available" 404s. Override via env.
const DEFAULT_MODEL = process.env.OMNISEARCH_GEMINI_MODEL || 'gemini-2.5-flash';
const API_HOST = 'https://generativelanguage.googleapis.com';

const MODELS = [
    // Current Gemini 2.5 family
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — top reasoning, premium', tier: 'premium', supportsWeb: true },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — fast & free, recommended', tier: 'standard', supportsWeb: true },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite — cheapest, fastest', tier: 'fast', supportsWeb: true },
    // Gemini 2.0 — pin to dated stable build (the bare 2.0-flash alias was retired)
    { id: 'gemini-2.0-flash-001', label: 'Gemini 2.0 Flash 001 — proven stable', tier: 'standard', supportsWeb: true },
    { id: 'gemini-2.0-flash-lite-001', label: 'Gemini 2.0 Flash-Lite 001 — cheap legacy', tier: 'fast', supportsWeb: true },
    // Legacy Gemini 1.5 — pin to dated stable build (bare aliases were retired)
    { id: 'gemini-1.5-pro-002', label: 'Gemini 1.5 Pro 002 — legacy premium', tier: 'legacy', supportsWeb: true },
    { id: 'gemini-1.5-flash-002', label: 'Gemini 1.5 Flash 002 — legacy workhorse', tier: 'legacy', supportsWeb: true },
];

const META = {
    id: 'gemini',
    name: 'Google Gemini',
    color: 'rose',
    keyPrefix: 'AIza',
    keyHelp: 'Get a free key at aistudio.google.com/app/apikey. Generous free tier (1,500 requests/day).',
    pricing: 'free tier · then very cheap',
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    supportsWeb: true,
};

function gem(apiKey, modelId, endpoint = 'streamGenerateContent') {
    // alt=sse asks Google to deliver the stream as Server-Sent Events
    // (one JSON chunk per `data:` line) instead of a JSON array — much
    // easier to consume incrementally.
    const sseParam = endpoint === 'streamGenerateContent' ? '&alt=sse' : '';
    return `${API_HOST}/v1beta/models/${modelId}:${endpoint}?key=${encodeURIComponent(apiKey)}${sseParam}`;
}

// Relaxed safety thresholds. The Gemini default is extremely conservative
// — designed for consumer chat where any mention of harm/violence/etc.
// must be filtered. For an internal-use enterprise search tool, the
// content is your own Slack/Confluence/ServiceNow data which routinely
// contains error codes, security discussion, customer complaints, and
// internal-sounding language. Without this, the "401 error in Data
// Connect" query gets blocked because Gemini reads it as "discussion of
// unauthorized access". We use BLOCK_ONLY_HIGH which still catches
// genuinely problematic content but lets normal enterprise text through.
//
// User can override per-deployment via env var if they need stricter
// behaviour (e.g. shared multi-tenant install).
const SAFETY_CATEGORIES = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
];
const SAFETY_THRESHOLD = process.env.GEMINI_SAFETY_THRESHOLD || 'BLOCK_ONLY_HIGH';
const SAFETY_SETTINGS = SAFETY_CATEGORIES.map((category) => ({ category, threshold: SAFETY_THRESHOLD }));

async function testKey(apiKey) {
    try {
        const resp = await fetch(gem(apiKey, DEFAULT_MODEL, 'generateContent'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'Reply with just the word OK.' }] }],
                generationConfig: { maxOutputTokens: 16 },
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return { ok: false, error: `HTTP ${resp.status}: ${body.substring(0, 200)}` };
        }
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { ok: /ok/i.test(text), model: DEFAULT_MODEL };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

// Parse a Gemini SSE stream. Each event is `data: {json}\n\n`.
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
            const line = block.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { yield JSON.parse(payload); } catch (_) { /* ignore malformed chunks */ }
        }
    }
}

async function synthesize({ query, results, apiKey, onChunk, model, systemPrompt }) {
    const picked = selectSources(results);
    if (picked.length === 0) throw new Error('NO_SOURCES');
    const modelId = model || DEFAULT_MODEL;

    const userText = buildUserMessage(query, picked);
    // Phase-1 agent integration: caller may pass a dynamically-composed
    // system prompt (intent classification + matching skill). Falls back to
    // the static SYSTEM_PROMPT when the agent layer is bypassed.
    const sysText = (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.length > 0) ? systemPrompt : SYSTEM_PROMPT;
    logger.info('Phase 6', `[gemini:${modelId}] sources=${picked.length} prompt=${userText.length} chars system=${sysText.length} chars`);
    const startedAt = Date.now();

    const body = {
        systemInstruction: { role: 'system', parts: [{ text: sysText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
        safetySettings: SAFETY_SETTINGS,
    };

    const resp = await fetch(gem(apiKey, modelId, 'streamGenerateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    let fullText = '';
    let usage = null;
    // Capture the final candidate so we can inspect finishReason / safety
    // ratings if no text comes back. Without this we silently return empty
    // and the UI hangs on "Reading sources…".
    let lastCandidate = null;
    let lastPromptFeedback = null;
    let chunkCount = 0;
    let textPartCount = 0;
    let thoughtPartCount = 0;
    for await (const chunk of sseLines(resp)) {
        chunkCount++;
        const cand = chunk?.candidates?.[0];
        if (cand) lastCandidate = cand;
        if (chunk?.promptFeedback) lastPromptFeedback = chunk.promptFeedback;
        const parts = cand?.content?.parts || [];
        for (const p of parts) {
            // Skip "thought" reasoning parts from extended-thinking variants.
            if (p?.thought) { thoughtPartCount++; continue; }
            if (typeof p.text === 'string' && p.text.length > 0) {
                textPartCount++;
                fullText += p.text;
                if (onChunk) try { onChunk(p.text); } catch (_) {}
            }
        }
        if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    }

    const elapsed = Date.now() - startedAt;

    // Empty text is a real failure mode — surface it loudly instead of
    // letting the UI hang on "Reading sources…".
    if (!fullText) {
        const finishReason = lastCandidate?.finishReason || 'UNKNOWN';
        const safety = (lastCandidate?.safetyRatings || [])
            .filter((r) => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM')
            .map((r) => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`)
            .join(', ');
        const blockReason = lastPromptFeedback?.blockReason;
        const blockReasonMsg = lastPromptFeedback?.blockReasonMessage;
        const promptSafety = (lastPromptFeedback?.safetyRatings || [])
            .filter((r) => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM')
            .map((r) => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`)
            .join(', ');
        const shape = JSON.stringify({
            chunks: chunkCount,
            textParts: textPartCount,
            thoughtParts: thoughtPartCount,
            finishReason,
            promptFeedback: lastPromptFeedback,
            partKinds: (lastCandidate?.content?.parts || []).map((p) => Object.keys(p || {})),
        });
        logger.warn('Phase 6', `[gemini:${modelId}] empty text in ${elapsed}ms · ${shape}`);

        // Build a precise user-facing error. Distinguish the three failure
        // modes so the next step is obvious:
        //   1. zero chunks → connection/quota issue, suggest retry
        //   2. promptFeedback.blockReason set → input was blocked,
        //      switch provider (Claude/OpenAI don't have this filter)
        //   3. finishReason=SAFETY → output was blocked mid-generation
        let userMsg;
        if (chunkCount === 0) {
            userMsg = `Gemini returned an empty response (no data chunks). This is usually a transient connectivity or quota issue — wait a moment and Re-ask, or switch to Anthropic Claude / OpenAI in Settings.`;
        } else if (blockReason) {
            userMsg = `Gemini blocked the prompt before answering (block=${blockReason}${blockReasonMsg ? ', "' + blockReasonMsg + '"' : ''}${promptSafety ? ', safety=' + promptSafety : ''}). Enterprise content with error codes / customer names / internal jargon trips Gemini's input filter even with relaxed settings. Switch to Anthropic Claude or OpenAI in Settings for this question — they handle enterprise content without filtering.`;
        } else if (finishReason === 'SAFETY') {
            userMsg = `Gemini blocked the answer mid-generation (finishReason=SAFETY${safety ? ', ' + safety : ''}). Switch to Anthropic Claude or OpenAI in Settings.`;
        } else {
            userMsg = `Gemini returned no answer text (finishReason=${finishReason}, chunks=${chunkCount}, textParts=${textPartCount}, thoughtParts=${thoughtPartCount}). The combined system + user prompt may be the cause — try a shorter query, or switch to Anthropic Claude / OpenAI in Settings.`;
        }
        throw new Error(userMsg);
    }

    logger.success('Phase 6', `[gemini:${modelId}] done in ${elapsed}ms · in=${usage?.promptTokenCount} out=${usage?.candidatesTokenCount} · ${chunkCount} chunks, ${textPartCount} text parts`);

    return {
        text: fullText,
        picked,
        usage: usage ? { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount, total_tokens: usage.totalTokenCount } : null,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Web variant: enables Gemini's built-in Google Search grounding. The model
// runs live searches and returns answers with grounded citations. Free tier
// supports this on the Flash models.
//
// We use non-streaming `generateContent` here because grounded responses
// often arrive as a single payload after the search tool runs — streaming
// added complexity without benefit and previously yielded empty text when
// the model emitted "thought" parts before the final answer.
async function synthesizeWithWeb({ query, apiKey, onChunk, model }) {
    const modelId = model || DEFAULT_MODEL;
    const startedAt = Date.now();
    logger.info('Phase 6', `[gemini:${modelId}:web] researching "${query}"`);

    const WEB_PROMPT = `Search the web for information about: "${query}"

Write a concise markdown answer with:
1. A one-sentence TL;DR
2. Key findings as bullet points (4-8 bullets)
3. A "Sources" section listing the URLs you used

Stay focused on what's actually in the search results. Do not speculate.`;

    // The grounding tool key differs across Gemini families:
    //   - Gemini 2.x  → `google_search`
    //   - Gemini 1.5  → `google_search_retrieval`
    const isLegacy = /^gemini-1\.5/.test(modelId);
    const tool = isLegacy ? { google_search_retrieval: {} } : { google_search: {} };

    // NOTE: do NOT pass safetySettings here — Gemini's grounded-search
    // endpoint returns HTTP 500 INTERNAL when both `tools` and
    // `safetySettings` are present together. The Google Search grounding
    // layer has its own internal safety handling.
    const body = {
        contents: [{ role: 'user', parts: [{ text: WEB_PROMPT }] }],
        tools: [tool],
        generationConfig: { maxOutputTokens: 3072, temperature: 0.3 },
    };

    const resp = await fetch(gem(apiKey, modelId, 'generateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini web HTTP ${resp.status}: ${errBody.substring(0, 400)}`);
    }

    const data = await resp.json();
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts || [];

    // Concatenate every textual part. Some grounded responses split the
    // answer across multiple parts; some include `thought:true` reasoning
    // parts we want to skip.
    let fullText = '';
    for (const p of parts) {
        if (p?.thought) continue;
        if (typeof p?.text === 'string') fullText += p.text;
    }

    // Extract grounded URLs. Newer responses expose them under
    // `groundingMetadata.groundingChunks[].web`; older ones under
    // `groundingAttributions[].web`. Handle both.
    const webSources = [];
    const seenUrls = new Set();
    const pushUrl = (uri, title) => {
        if (!uri || seenUrls.has(uri)) return;
        seenUrls.add(uri);
        webSources.push({ title: title || uri, url: uri, snippet: null });
    };
    const grounding = cand?.groundingMetadata;
    if (Array.isArray(grounding?.groundingChunks)) {
        for (const g of grounding.groundingChunks) pushUrl(g?.web?.uri, g?.web?.title);
    }
    if (Array.isArray(grounding?.groundingAttributions)) {
        for (const g of grounding.groundingAttributions) pushUrl(g?.web?.uri, g?.web?.title);
    }
    if (Array.isArray(grounding?.searchEntryPoint?.renderedContent)) {
        // best-effort: rendered content sometimes contains anchor URLs
    }

    // If Gemini blocked the response (safety filter or similar), surface that.
    if (!fullText && cand?.finishReason && cand.finishReason !== 'STOP') {
        const reason = cand.finishReason;
        const safety = cand?.safetyRatings?.map((r) => `${r.category}:${r.probability}`).join(', ') || '';
        throw new Error(`Gemini returned no text (finishReason=${reason}${safety ? ' · ' + safety : ''}). Try a different query or model.`);
    }

    if (!fullText) {
        // Dump shape so we can diagnose if Gemini ever returns an unexpected layout.
        const shape = JSON.stringify({
            partCount: parts.length,
            partKinds: parts.map((p) => Object.keys(p || {})),
            finishReason: cand?.finishReason,
            promptFeedback: data?.promptFeedback,
        });
        logger.warn('Phase 6', `[gemini:${modelId}:web] empty text · ${shape}`);
        throw new Error('Gemini returned no answer text. Your model may not support web grounding on the free tier — try gemini-1.5-flash or switch to Anthropic Claude.');
    }

    // Emit the full text as one chunk so the UI renders it.
    if (onChunk) try { onChunk(fullText); } catch (_) {}

    const usage = data?.usageMetadata
        ? { input_tokens: data.usageMetadata.promptTokenCount, output_tokens: data.usageMetadata.candidatesTokenCount }
        : null;

    const elapsed = Date.now() - startedAt;
    logger.success('Phase 6', `[gemini:${modelId}:web] done in ${elapsed}ms · sources=${webSources.length} · chars=${fullText.length}`);

    return {
        text: fullText,
        webSources,
        usage,
        model: modelId,
        elapsedMs: elapsed,
    };
}

// Lightweight non-streaming chat helper for the agent's intent classifier.
// Returns the model's plain text response. Skips streaming, grounding, and
// safety-rating handling — keeps classification calls fast and predictable.
async function chat(systemPrompt, userPrompt, { apiKey, model, maxTokens = 256 } = {}) {
    const modelId = model || DEFAULT_MODEL;
    const body = {
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 },
        safetySettings: SAFETY_SETTINGS,
    };
    const resp = await fetch(gem(apiKey, modelId, 'generateContent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Gemini chat HTTP ${resp.status}: ${errBody.substring(0, 200)}`);
    }
    const data = await resp.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

module.exports = { META, testKey, synthesize, synthesizeWithWeb, chat };
