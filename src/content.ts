const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetLanguage: 'ko',
};

const SUBTITLE_SELECTORS = [
  '[data-purpose="captions-text"]',
  '[class*="captions-text"]',
  '[class*="captions-display"]',
  '[class*="well--container"]',
];

const VTT_URL_PATTERN = /\.vtt(\?|$)/i;
const VTT_SPRITE_PATTERN = /thumb-?sprites|sprite|xywh=/i;
const PREFETCH_THROTTLE_MS = 700;
const TRANSLATION_CACHE_LIMIT = 1500;

let settings: Settings = { ...DEFAULT_SETTINGS };
const translationCache = new Map<string, string>();
const translationInFlight = new Map<string, Promise<string>>();
let vttUrl: string | null = null;
let lastPrefetchAt = 0;
let lastPrefetchVideoTime = -1;
let renderScheduled = false;
let prefetchTimer: number | null = null;

async function refreshSettings() {
  settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
}

function isInMainCaptionArea(element: HTMLElement) {
  const isCueText =
    element.getAttribute('data-purpose') === 'captions-cue-text' ||
    element.className.includes('captions-cue-text') ||
    element.className.includes('well--container');
  return isCueText;
}

function getCaptionCandidates(): HTMLElement[] {
  const nodes: HTMLElement[] = [];

  SUBTITLE_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      if (element.closest('.udemy-dual-subtitle')) {
        return;
      }

      nodes.push(element);
    });
  });

  return [...new Set(nodes)].filter(isInMainCaptionArea);
}

function getPrimaryText(element: HTMLElement) {
  const cloned = element.cloneNode(true) as HTMLElement;
  cloned
    .querySelectorAll('.udemy-dual-subtitle')
    .forEach((node) => node.remove());
  return cloned.textContent?.trim() ?? '';
}

function normalizeCaptionText(text: string) {
  let normalized = text.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  normalized = normalized.replace(/^[-–]\s+/, '');
  normalized = normalized.replace(
    /^([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}):\s+/,
    '',
  );
  return normalized.trim();
}

function setLruCache<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  if (cache.size <= limit) {
    return;
  }
  const oldestKey = cache.keys().next().value;
  if (oldestKey === undefined) {
    return;
  }
  cache.delete(oldestKey);
}

async function requestTranslation(text: string): Promise<string> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        text,
        targetLanguage: settings.targetLanguage,
      },
      (response: TranslateResponse) => {
        if (chrome.runtime.lastError || !response?.ok) {
          resolve('');
          return;
        }

        resolve(response.translatedText ?? '');
      },
    );
  });
}

async function getTranslation(
  text: string,
  targetLanguage: string,
): Promise<string> {
  const cacheKey = `${targetLanguage}::${text}`;
  const cached = translationCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const pending = translationInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = requestTranslation(text)
    .then((translated) => {
      setLruCache(
        translationCache,
        cacheKey,
        translated,
        TRANSLATION_CACHE_LIMIT,
      );
      return translated;
    })
    .finally(() => {
      translationInFlight.delete(cacheKey);
    });

  translationInFlight.set(cacheKey, request);
  return request;
}

function getVideoTime() {
  const video = document.querySelector('video');
  if (!(video instanceof HTMLVideoElement)) {
    return null;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return null;
  }

  if (video.paused || video.ended) {
    return null;
  }

  if (Number.isNaN(video.currentTime)) {
    return null;
  }

  return video.currentTime;
}

function prefetchUpcomingTranslations() {
  if (!settings.enabled || !vttUrl) {
    return;
  }

  const now = Date.now();
  if (now - lastPrefetchAt < PREFETCH_THROTTLE_MS) {
    return;
  }

  const time = getVideoTime();
  if (time === null) {
    return;
  }

  if (Math.abs(time - lastPrefetchVideoTime) < 0.2) {
    return;
  }

  lastPrefetchAt = now;
  lastPrefetchVideoTime = time;
  chrome.runtime.sendMessage(
    {
      type: 'PREFETCH_VTT',
      url: vttUrl,
      targetLanguage: settings.targetLanguage,
      currentTime: time,
    },
    (response: PrefetchVttResponse) => {
      if (chrome.runtime.lastError || !response?.ok) {
        return;
      }

      for (const item of response.items) {
        const normalizedText = normalizeCaptionText(item.text);
        if (!normalizedText) {
          continue;
        }
        const cacheKey = `${settings.targetLanguage}::${normalizedText}`;
        setLruCache(
          translationCache,
          cacheKey,
          item.translatedText,
          TRANSLATION_CACHE_LIMIT,
        );
      }
    },
  );
}

function startPrefetchLoop() {
  if (!settings.enabled) {
    return;
  }

  if (prefetchTimer !== null) {
    return;
  }

  prefetchTimer = window.setInterval(() => {
    prefetchUpcomingTranslations();
  }, PREFETCH_THROTTLE_MS);
}

function stopPrefetchLoop() {
  if (prefetchTimer === null) {
    return;
  }

  window.clearInterval(prefetchTimer);
  prefetchTimer = null;
}

function discoverVttUrl() {
  const track = document.querySelector(
    'track[kind="subtitles"], track[kind="captions"]',
  );
  if (track instanceof HTMLTrackElement && track.src) {
    return track.src;
  }

  const resources = performance.getEntriesByType('resource');
  for (const resource of resources) {
    if (resource instanceof PerformanceResourceTiming) {
      if (
        VTT_URL_PATTERN.test(resource.name) &&
        !VTT_SPRITE_PATTERN.test(resource.name)
      ) {
        return resource.name;
      }
    }
  }

  return null;
}

function setupVttDiscovery() {
  const initial = discoverVttUrl();
  if (initial) {
    vttUrl = initial;
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (
        entry instanceof PerformanceResourceTiming &&
        VTT_URL_PATTERN.test(entry.name) &&
        !VTT_SPRITE_PATTERN.test(entry.name)
      ) {
        vttUrl = entry.name;
        prefetchUpcomingTranslations();
        break;
      }
    }
  });

  observer.observe({ type: 'resource', buffered: true });
}

async function updateDualSubtitle(element: HTMLElement) {
  if (!settings.enabled) {
    element
      .querySelectorAll('.udemy-dual-subtitle')
      .forEach((node) => node.remove());
    return;
  }

  const sourceText = getPrimaryText(element);
  const normalizedText = normalizeCaptionText(sourceText);
  if (!normalizedText) {
    return;
  }

  if (
    element.dataset.dualSubtitleSource === normalizedText &&
    element.dataset.dualSubtitleLang === settings.targetLanguage
  ) {
    return;
  }

  let translationNode = element.querySelector(':scope > .udemy-dual-subtitle');
  if (!translationNode) {
    translationNode = document.createElement('div');
    translationNode.className = 'udemy-dual-subtitle';
    element.appendChild(translationNode);
  }

  const cacheKey = `${settings.targetLanguage}::${normalizedText}`;
  const cached = translationCache.get(cacheKey);
  if (cached !== undefined) {
    translationNode.textContent = cached;
    translationNode.classList.remove('pending');
  } else {
    translationNode.textContent = '…';
    translationNode.classList.add('pending');
  }

  element.dataset.dualSubtitleSource = normalizedText;
  element.dataset.dualSubtitleLang = settings.targetLanguage;

  const translatedText = await getTranslation(
    normalizedText,
    settings.targetLanguage,
  );
  if (!translatedText) {
    return;
  }

  translationNode.textContent = translatedText;
  translationNode.classList.remove('pending');
}

async function renderAll() {
  const candidates = getCaptionCandidates();
  await Promise.all(candidates.map((element) => updateDualSubtitle(element)));
}

function scheduleRender() {
  if (renderScheduled) {
    return;
  }

  renderScheduled = true;
  window.requestAnimationFrame(() => {
    renderScheduled = false;
    void renderAll();
  });
}

const observer = new MutationObserver(() => {
  scheduleRender();
});

function setupDevReload() {
  if (!import.meta.env.DEV) {
    return;
  }

  let source: EventSource | null = null;

  const connect = () => {
    source = new EventSource('http://localhost:35729/events');

    source.addEventListener('reload', () => {
      chrome.runtime.reload();
    });

    source.onerror = () => {
      if (source) {
        source.close();
      }
      setTimeout(connect, 1000);
    };
  };

  connect();
}

async function init() {
  await refreshSettings();
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scheduleRender();
  setupVttDiscovery();
  startPrefetchLoop();
  setupDevReload();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  if (changes.enabled) {
    settings.enabled = changes.enabled.newValue;
    if (!settings.enabled) {
      stopPrefetchLoop();
    } else {
      startPrefetchLoop();
    }
  }

  if (changes.targetLanguage) {
    settings.targetLanguage = changes.targetLanguage.newValue;
  }

  scheduleRender();
});

init();
