require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { Document } = require('flexsearch');
const logger = require('../utils/logger');

let websiteIndex = null;
let indexedPages = [];
let lastIndexed = null;

function getIndex() {
    if (!websiteIndex) {
        websiteIndex = new Document({
            document: {
                id: 'id',
                index: ['title', 'content'],
                store: ['title', 'url', 'snippet'],
            },
        });
    }

    return websiteIndex;
}

async function crawlPage(url, visited = new Set(), depth = 0, maxDepth = 2) {
    if (visited.has(url) || depth > maxDepth) {
        return [];
    }

    visited.add(url);

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': 'PerfectSearch/1.0 internal crawler' },
        });

        const $ = cheerio.load(response.data);
        const title = $('title').text().trim() || $('h1').first().text().trim() || url;
        const content = $('main, article, .content, body').text().replace(/\s+/g, ' ').trim().substring(0, 2000);
        const snippet = content.substring(0, 200);
        const pages = [{ url, title, content, snippet }];

        if (depth < maxDepth) {
            const origin = new URL(url).origin;
            const links = [];

            $('a[href]').each((_index, element) => {
                try {
                    const nextUrl = new URL($(element).attr('href'), url).href;
                    if (nextUrl.startsWith(origin) && !visited.has(nextUrl)) {
                        links.push(nextUrl);
                    }
                } catch (_error) {
                    // Ignore malformed links
                }
            });

            for (const link of links.slice(0, 10)) {
                const nestedPages = await crawlPage(link, visited, depth + 1, maxDepth);
                pages.push(...nestedPages);
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
        }

        return pages;
    } catch (error) {
        logger.warn('Phase 3', `Website crawl failed for ${url}: ${error.message}`);
        return [];
    }
}

function clearWebsiteIndex() {
    websiteIndex = null;
    indexedPages = [];
    lastIndexed = null;
}

async function buildIndex(force = false) {
    const websiteUrl = process.env.WEBSITE_URL;
    if (!websiteUrl) {
        logger.warn('Phase 3', 'WEBSITE_URL not set, skipping website indexing');
        return [];
    }

    const cacheTtl = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
    if (!force && lastIndexed && Date.now() - lastIndexed.getTime() < cacheTtl) {
        return indexedPages;
    }

    clearWebsiteIndex();
    logger.info('Phase 3', `Building website index from ${websiteUrl}`);

    const pages = await crawlPage(websiteUrl);
    const index = getIndex();

    pages.forEach((page, indexId) => {
        index.add({ id: indexId, ...page });
    });

    indexedPages = pages;
    lastIndexed = new Date();
    logger.success('Phase 3', `Indexed ${pages.length} website page(s)`);
    return indexedPages;
}

async function searchWebsite(query) {
    const cacheTtl = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
    if (!lastIndexed || Date.now() - lastIndexed.getTime() > cacheTtl) {
        await buildIndex();
    }

    if (!websiteIndex) {
        return [];
    }

    try {
        const results = websiteIndex.search(query, { limit: 10, enrich: true });
        const siteName = process.env.WEBSITE_NAME || 'Website';
        const mapped = [];

        for (const field of results) {
            for (const item of field.result) {
                if (!mapped.find((entry) => entry.id === `web-${item.id}`)) {
                    mapped.push({
                        id: `web-${item.id}`,
                        source: siteName,
                        type: 'Page',
                        title: item.doc?.title || 'Untitled',
                        snippet: item.doc?.snippet || '',
                        link: item.doc?.url || '',
                        score: 0,
                    });
                }
            }
        }

        logger.success('Phase 3', `Website returned ${mapped.length} result(s)`);
        return mapped;
    } catch (error) {
        logger.error('Phase 3', 'Website search failed', error);
        return [];
    }
}

module.exports = { searchWebsite, buildIndex, clearWebsiteIndex };
