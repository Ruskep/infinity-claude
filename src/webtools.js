// Веб-инструменты агента: поиск и чтение страниц.
// Поиск — через DuckDuckGo HTML (без API-ключей). Чтение — скрытое окно Chromium,
// чтобы страницы с JS-рендером тоже открывались; результат приводим к тексту/markdown.

const { BrowserWindow } = require('electron');
const path = require('path');

const MAX_RESULTS = 8;
const MAX_WEB_TEXT = 60000; // символов страницы, отдаём модели

async function webSearch(query) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return JSON.stringify({ ok: false, error: 'Пустой запрос' });
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  const html = await fetchText(url, { timeout: 20000 });
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < MAX_RESULTS) {
    let href = m[1];
    const label = stripTags(m[2]).trim();
    if (href.startsWith('//')) href = 'https:' + href;
    if (/uddg=/.test(href)) {
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
    }
    if (!/^https?:\/\//.test(href)) continue;
    if (!label) continue;
    results.push({ title: label, url: href });
  }
  let i = 0;
  while ((m = snipRe.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripTags(m[1]).trim().slice(0, 300);
    i++;
  }
  if (!results.length) return JSON.stringify({ ok: true, query: String(query), results: [], note: 'Найдено не найдено — возможно, DDG отдал капчу. Попробуй переформулировать.' });
  return JSON.stringify({ ok: true, query: String(query), results });
}

async function webFetch(url) {
  const clean = normalizeUrl(url);
  if (!clean) return JSON.stringify({ ok: false, error: 'Неверный URL' });
  if (!/^https?:\/\//i.test(clean)) return JSON.stringify({ ok: false, error: 'Разрешены только http/https ссылки' });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: 'persist:webview',
      javascript: true,
      images: false,
      autoplayPolicy: 'no-user-gesture-required',
      webSecurity: true,
      sandbox: true,
      offscreen: false
    }
  });

  try {
    await win.loadURL(clean, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
    // даём JS-сайтам время отрендериться
    await sleep(2500);

    const text = await win.webContents.executeJavaScript(`(() => {
      const NOISE = 'script,noscript,style,link,meta,svg,canvas,iframe,form,button,nav,footer,header,aside,svg';
      document.querySelectorAll(NOISE).forEach(el => el.remove());
      const title = document.title || '';
      const body = document.body ? document.body.innerText : '';
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.getAttribute('href') || '';
        if (/^https?:\\/\\//.test(h) && links.length < 12 && a.innerText.trim().length < 120) {
          links.push(a.innerText.trim() + ' -> ' + h);
        }
      });
      return { title: title, text: body, links: links };
    })()`);

    const title = (text.title || '').trim();
    let content = (text.text || '').trim();
    if (content.length > MAX_WEB_TEXT) content = content.slice(0, MAX_WEB_TEXT) + '\n…[обрезано]';

    return JSON.stringify({
      ok: true,
      url: win.webContents.getURL() || clean,
      title,
      content,
      links: (text.links || []).slice(0, 10)
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err), url: clean });
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) return 'https://' + u;
  return u;
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'ru,en;q=0.8'
      },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { webSearch, webFetch };