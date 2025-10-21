import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright-extra';
import stealth from 'playwright-extra-plugin-stealth';

chromium.use(stealth());

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;

app.post('/youtube/fetch', async (req, res) => {
    const { channelId, options = {} } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const headless = options.headless ?? true;
    const proxy = options.proxy || process.env.PLAYWRIGHT_PROXY || '';

    const launchOptions = { headless };
    if (proxy) launchOptions.proxy = { server: proxy };

    let browser;
    try {
        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({ locale: options.acceptLanguage || 'ja,en-US,en' });
        const page = await context.newPage();
        const url = `https://www.youtube.com/channel/${channelId}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Try to read subscriber count text
        const text = await page.evaluate(() => {
            const el = document.querySelector('#subscriber-count, yt-formatted-string#owner-sub-count');
            return el ? el.textContent : '';
        });

        const normalized = (text || '').replace(/subscribers?/i, '').trim();
        const count = parseHumanCount(normalized);

        await browser.close();
        browser = null;
        if (typeof count === 'number') {
            return res.json({ subscriberCount: count, visible: true });
        }
        return res.json({ visible: false });
    } catch (e) {
        if (browser) await browser.close();
        return res.status(500).json({ error: String(e && e.message || e) });
    }
});

app.post('/x/fetch', async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`https://twitter.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Very naive: try to read followers from the profile meta via aria-label or data-testids
        const text = await page.evaluate(() => {
            const sel = 'a[href$="/followers"] [dir="auto"] span';
            const node = document.querySelector(sel);
            return node ? node.textContent : '';
        });

        const count = parseHumanCount((text || '').trim());

        await browser.close();
        browser = null;
        if (typeof count === 'number') return res.json({ followersCount: count, visible: true });
        return res.json({ visible: false });
    } catch (e) {
        if (browser) await browser.close();
        return res.status(500).json({ error: String(e && e.message || e) });
    }
});

function parseHumanCount(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const comma = /^\d{1,3}(,\d{3})+$/;
    if (comma.test(t)) return parseInt(t.replace(/,/g, ''), 10);
    const m = t.match(/^(\d+(?:\.\d+)?)([KMB])$/i);
    if (m) {
        const num = parseFloat(m[1]);
        const suf = m[2].toUpperCase();
        const fac = suf === 'K' ? 1e3 : suf === 'M' ? 1e6 : 1e9;
        return Math.round(num * fac);
    }
    const man = t.match(/^(\d+(?:\.\d+)?)万$/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return null;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Playwright server listening on :${PORT}`));


