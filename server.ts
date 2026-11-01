import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { LiveViewResponse, ViewTick } from './src/types/youtube.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INNERTUBE_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20240726.00.00',
  hl: 'en',
  gl: 'ID',
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PERSIST_FILE = path.join(os.tmpdir(), 'pantauview-streams-v2.json');
const MAX_TICKS = 2000;

interface CachedVideoMeta {
  title: string;
  channelId: string;
  channelName: string;
  channelHandle: string;
  avatarUrl: string;
  publishedAt: string | null;
  lastFullMetaMs: number;
}

interface WatchedVideoStream {
  meta: CachedVideoMeta;
  ticks: ViewTick[];
  confirmedViews: number;
  lowerStreakCount: number;
  lastClientAccessMs: number;
  lastProbeRttMs: number;
  lastVerifiedSources: number;
  inFlight: Promise<LiveViewResponse> | null;
  sseClients: Set<express.Response>;
}

const streamStore = new Map<string, WatchedVideoStream>();

function loadPersistedStreams(): void {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = fs.readFileSync(PERSIST_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<
      string,
      { meta: CachedVideoMeta; ticks: ViewTick[]; confirmedViews: number }
    >;
    const nowMs = Date.now();
    for (const [vid, item] of Object.entries(parsed)) {
      if (item && Array.isArray(item.ticks) && item.meta) {
        streamStore.set(vid, {
          meta: item.meta,
          ticks: item.ticks.slice(-MAX_TICKS),
          confirmedViews: item.confirmedViews ?? 0,
          lowerStreakCount: 0,
          lastClientAccessMs: nowMs,
          lastProbeRttMs: 0,
          lastVerifiedSources: 1,
          inFlight: null,
          sseClients: new Set(),
        });
      }
    }
  } catch {
    // Ignore corrupted cache file
  }
}

let lastDiskFlushMs = 0;
function persistStreamsThrottled(force = false): void {
  const nowMs = Date.now();
  if (!force && nowMs - lastDiskFlushMs < 8_000) return;
  lastDiskFlushMs = nowMs;

  try {
    const serializable: Record<
      string,
      { meta: CachedVideoMeta; ticks: ViewTick[]; confirmedViews: number }
    > = {};
    for (const [vid, s] of streamStore.entries()) {
      serializable[vid] = {
        meta: s.meta,
        ticks: s.ticks.slice(-MAX_TICKS),
        confirmedViews: s.confirmedViews,
      };
    }
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(serializable), 'utf-8');
  } catch {
    // Ignore disk write errors
  }
}

loadPersistedStreams();

function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    if (
      host === 'youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const vParam = url.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) return vParam;

      const segments = url.pathname.split('/').filter(Boolean);
      if (
        segments.length >= 2 &&
        ['shorts', 'embed', 'live', 'v'].includes(segments[0]) &&
        /^[a-zA-Z0-9_-]{11}$/.test(segments[1])
      ) {
        return segments[1];
      }
    }
  } catch {
    // Fallback regex
  }

  const regexMatch = trimmed.match(
    /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/
  );
  return regexMatch ? regexMatch[1] : null;
}

function parseExactIntegerViews(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned.includes('no view') || cleaned.includes('belum ada')) return 0;
  // Reject abbreviated compact strings like "1.2K" or "3.4M" so we only use exact integers
  if (/\d\s*[kmb]|rb|jt/i.test(cleaned)) return null;

  const digitsOnly = cleaned.replace(/[^\d]/g, '');
  if (!digitsOnly) return null;
  const parsed = parseInt(digitsOnly, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function probeUpdatedMetadataEndpoint(videoId: string, nonce: number): Promise<number | null> {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false&_n=${nonce}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        context: { client: INNERTUBE_CLIENT },
        videoId,
      }),
    }
  );
  if (!res.ok) return null;
  const json: any = await res.json();
  const actions: any[] = json?.actions || [];
  for (const act of actions) {
    const renderer = act?.updateViewershipAction?.viewCount?.videoViewCountRenderer;
    if (renderer) {
      const exactOrig = parseExactIntegerViews(String(renderer.originalViewCount ?? ''));
      if (exactOrig !== null) return exactOrig;
      const unlabeled = parseExactIntegerViews(renderer?.unlabeledViewCountValue?.simpleText);
      if (unlabeled !== null) return unlabeled;
      const simple = parseExactIntegerViews(renderer?.viewCount?.simpleText);
      if (simple !== null) return simple;
    }
  }
  return null;
}

async function probeNextEndpoint(videoId: string, nonce: number) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/next?prettyPrint=false&_n=${nonce}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        context: { client: INNERTUBE_CLIENT },
        videoId,
      }),
    }
  );
  if (!res.ok) throw new Error('Gagal menghubungi server YouTube.');
  const nextJson: any = await res.json();
  const contents: any[] =
    nextJson?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];

  const primary = contents.find((c) => c?.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
  const secondary = contents.find((c) => c?.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
  if (!primary) {
    throw new Error('Video tidak ditemukan atau bersifat pribadi.');
  }

  const title: string =
    primary?.title?.runs?.map((r: any) => r.text).join('') || `Video ${videoId}`;

  const viewRenderer = primary?.viewCount?.videoViewCountRenderer;
  const origViews = parseExactIntegerViews(String(viewRenderer?.originalViewCount ?? ''));
  const simpleViews = parseExactIntegerViews(viewRenderer?.viewCount?.simpleText);

  // Also check structured description factoidRenderer for exact unrounded integer
  let factoidViews: number | null = null;
  const rawStr = JSON.stringify(nextJson?.engagementPanels || []);
  const factoidMatches = [
    ...rawStr.matchAll(
      /"factoidRenderer":\{"value":\{"simpleText":"([^"]+)"\},"label":\{"simpleText":"([^"]+)"\}/g
    ),
  ];
  for (const m of factoidMatches) {
    if (m[2]?.toLowerCase().includes('view')) {
      factoidViews = parseExactIntegerViews(m[1]);
    }
  }

  const owner = secondary?.owner?.videoOwnerRenderer;
  const channelName: string = owner?.title?.runs?.[0]?.text || 'YouTube Channel';
  const channelId: string = owner?.navigationEndpoint?.browseEndpoint?.browseId || '';
  const canonicalBase: string =
    owner?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
  const channelHandle = canonicalBase.startsWith('/') ? canonicalBase.slice(1) : canonicalBase;
  const avatars: any[] = owner?.thumbnail?.thumbnails || [];
  const avatarUrl: string = avatars.length > 0 ? avatars[avatars.length - 1].url : '';
  const dateStr: string = primary?.dateText?.simpleText || '';

  return {
    title,
    channelId,
    channelName,
    channelHandle,
    avatarUrl,
    dateStr,
    origViews,
    simpleViews,
    factoidViews,
  };
}

async function probeRssFeed(
  channelId: string,
  videoId: string,
  nonce: number
): Promise<{ publishedAt: string | null; rssViews: number | null }> {
  if (!channelId) return { publishedAt: null, rssViews: null };
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}&_n=${nonce}`,
      {
        headers: {
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
          'User-Agent': USER_AGENT,
        },
      }
    );
    if (!res.ok) return { publishedAt: null, rssViews: null };
    const xml = await res.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    for (const m of entries) {
      const block = m[1];
      const vId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
      if (vId === videoId) {
        const pub = block.match(/<published>([^<]+)<\/published>/)?.[1]?.trim() || null;
        const vStr = block.match(/<media:statistics\s+views="(\d+)"/)?.[1];
        const rssViews = vStr ? parseInt(vStr, 10) : null;
        return {
          publishedAt: pub,
          rssViews: rssViews !== null && !Number.isNaN(rssViews) ? rssViews : null,
        };
      }
    }
  } catch {
    // Ignore optional RSS errors
  }
  return { publishedAt: null, rssViews: null };
}

function buildPayload(videoId: string, stream: WatchedVideoStream, sampleMs: number): LiveViewResponse {
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: stream.meta.title,
    channelName: stream.meta.channelName,
    channelHandle: stream.meta.channelHandle,
    avatarUrl: stream.meta.avatarUrl,
    publishedAt: stream.meta.publishedAt,
    fetchedAt: new Date(sampleMs).toISOString(),
    probeRttMs: stream.lastProbeRttMs,
    verifiedSources: stream.lastVerifiedSources,
    views: stream.confirmedViews,
    history: stream.ticks,
  };
}

function broadcastSse(videoId: string, stream: WatchedVideoStream, sampleMs: number): void {
  if (stream.sseClients.size === 0) return;
  const latestTick = stream.ticks[stream.ticks.length - 1];
  const msg = JSON.stringify({
    videoId,
    views: stream.confirmedViews,
    probeRttMs: stream.lastProbeRttMs,
    verifiedSources: stream.lastVerifiedSources,
    fetchedAt: new Date(sampleMs).toISOString(),
    tick: latestTick,
  });
  for (const client of stream.sseClients) {
    try {
      client.write(`data: ${msg}\n\n`);
    } catch {
      stream.sseClients.delete(client);
    }
  }
}

async function sampleAccurateLiveVideo(
  videoId: string,
  markActiveAccess: boolean
): Promise<LiveViewResponse> {
  const reqStartMs = Date.now();
  let stream = streamStore.get(videoId);

  if (stream && markActiveAccess) {
    stream.lastClientAccessMs = reqStartMs;
  }

  if (stream?.inFlight) {
    return stream.inFlight;
  }

  const task = (async (): Promise<LiveViewResponse> => {
    const nonce = reqStartMs;
    const needFullMeta =
      !stream || !stream.meta.channelId || reqStartMs - stream.meta.lastFullMetaMs > 20_000;

    const candidates: number[] = [];

    if (needFullMeta) {
      const [updRes, nextRes] = await Promise.allSettled([
        probeUpdatedMetadataEndpoint(videoId, nonce),
        probeNextEndpoint(videoId, nonce),
      ]);

      if (nextRes.status === 'rejected' && !stream) {
        throw nextRes.reason;
      }

      if (updRes.status === 'fulfilled' && updRes.value !== null) {
        candidates.push(updRes.value);
      }

      let publishedAt = stream?.meta.publishedAt ?? null;
      if (nextRes.status === 'fulfilled') {
        const nx = nextRes.value;
        if (nx.origViews !== null) candidates.push(nx.origViews);
        if (nx.factoidViews !== null) candidates.push(nx.factoidViews);
        if (candidates.length === 0 && nx.simpleViews !== null) {
          candidates.push(nx.simpleViews);
        }

        const { publishedAt: rssPub, rssViews } = await probeRssFeed(
          nx.channelId,
          videoId,
          nonce
        );
        if (rssPub) publishedAt = rssPub;
        if (rssViews !== null) candidates.push(rssViews);

        if (!publishedAt && nx.dateStr) {
          const cleaned = nx.dateStr.replace(/^(Premiered|Streamed live on|Published on)\s+/i, '');
          const parsed = new Date(cleaned);
          if (!Number.isNaN(parsed.getTime())) {
            publishedAt = parsed.toISOString();
          }
        }

        if (!stream) {
          stream = {
            meta: {
              title: nx.title,
              channelId: nx.channelId,
              channelName: nx.channelName,
              channelHandle: nx.channelHandle,
              avatarUrl: nx.avatarUrl,
              publishedAt,
              lastFullMetaMs: reqStartMs,
            },
            ticks: [],
            confirmedViews: 0,
            lowerStreakCount: 0,
            lastClientAccessMs: reqStartMs,
            lastProbeRttMs: 0,
            lastVerifiedSources: 1,
            inFlight: null,
            sseClients: new Set(),
          };
          streamStore.set(videoId, stream);
        } else {
          stream.meta = {
            title: nx.title,
            channelId: nx.channelId || stream.meta.channelId,
            channelName: nx.channelName,
            channelHandle: nx.channelHandle,
            avatarUrl: nx.avatarUrl || stream.meta.avatarUrl,
            publishedAt,
            lastFullMetaMs: reqStartMs,
          };
        }
      }
    } else if (stream) {
      // Fast multi-source consensus: updated_metadata (~70ms) + RSS XML in parallel
      const [updRes, rssRes] = await Promise.allSettled([
        probeUpdatedMetadataEndpoint(videoId, nonce),
        probeRssFeed(stream.meta.channelId, videoId, nonce),
      ]);

      if (updRes.status === 'fulfilled' && updRes.value !== null) {
        candidates.push(updRes.value);
      }
      if (rssRes.status === 'fulfilled' && rssRes.value.rssViews !== null) {
        candidates.push(rssRes.value.rssViews);
        if (rssRes.value.publishedAt && !stream.meta.publishedAt) {
          stream.meta.publishedAt = rssRes.value.publishedAt;
        }
      }

      // Fallback to /next if fast endpoints returned nothing
      if (candidates.length === 0) {
        const nx = await probeNextEndpoint(videoId, nonce);
        if (nx.origViews !== null) candidates.push(nx.origViews);
        if (nx.factoidViews !== null) candidates.push(nx.factoidViews);
      }
    }

    if (!stream) {
      throw new Error('Gagal menginisialisasi stream pantauan video.');
    }

    const resEndMs = Date.now();
    // NTP-style midpoint timestamping eliminates network RTT skew
    const exactMidpointMs = Math.round((reqStartMs + resEndMs) / 2);
    stream.lastProbeRttMs = Math.max(1, resEndMs - reqStartMs);
    stream.lastVerifiedSources = Math.max(1, candidates.length);

    if (candidates.length > 0) {
      const maxObserved = Math.max(...candidates);

      if (stream.ticks.length === 0) {
        stream.confirmedViews = maxObserved;
        stream.lowerStreakCount = 0;
      } else if (maxObserved >= stream.confirmedViews) {
        stream.confirmedViews = maxObserved;
        stream.lowerStreakCount = 0;
      } else {
        // Anti-replica-rollback filter: require 3 consecutive lower probes before accepting downward audit
        stream.lowerStreakCount += 1;
        if (stream.lowerStreakCount >= 3) {
          stream.confirmedViews = maxObserved;
          stream.lowerStreakCount = 0;
        }
      }
    }

    const prevTick = stream.ticks[stream.ticks.length - 1];
    const valueChanged = !prevTick || prevTick.views !== stream.confirmedViews;
    const minIntervalElapsed = !prevTick || exactMidpointMs - prevTick.epochMs >= 1800;

    if (valueChanged || minIntervalElapsed) {
      stream.ticks.push({
        timestamp: new Date(exactMidpointMs).toISOString(),
        epochMs: exactMidpointMs,
        views: stream.confirmedViews,
      });
      if (stream.ticks.length > MAX_TICKS) {
        stream.ticks.splice(0, stream.ticks.length - MAX_TICKS);
      }
      persistStreamsThrottled(valueChanged);
      broadcastSse(videoId, stream, exactMidpointMs);
    }

    return buildPayload(videoId, stream, exactMidpointMs);
  })();

  if (stream) {
    stream.inFlight = task;
  }

  try {
    return await task;
  } finally {
    const active = streamStore.get(videoId);
    if (active) active.inFlight = null;
  }
}

// High-precision 2.5s background sampler for active streams
setInterval(() => {
  const nowMs = Date.now();
  for (const [videoId, stream] of streamStore.entries()) {
    const hasConnectedSse = stream.sseClients.size > 0;
    const recentlyAccessed = nowMs - stream.lastClientAccessMs <= 30 * 60_000;
    if (!hasConnectedSse && !recentlyAccessed) {
      continue;
    }
    sampleAccurateLiveVideo(videoId, false).catch(() => {});
  }
}, 2500);

// Warm up default video immediately on server boot
sampleAccurateLiveVideo('u3vex1jIlAM', true).catch(() => {});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Snapshot + full server buffer endpoint
  app.get('/api/youtube/live', async (req, res) => {
    try {
      const rawUrl = String(req.query.url || '').trim();
      const videoId = extractVideoId(rawUrl);
      if (!videoId) {
        res.status(400).json({
          error: 'Tautan YouTube tidak valid. Masukkan link youtu.be/... atau youtube.com/watch?v=...',
        });
        return;
      }

      const data = await sampleAccurateLiveVideo(videoId, true);
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    } catch (err: any) {
      res.status(500).json({
        error: err?.message || 'Gagal mengambil tayangan real-time dari YouTube.',
      });
    }
  });

  // Real-Time Server-Sent Events (SSE) Push Stream
  app.get('/api/youtube/stream', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    const videoId = extractVideoId(rawUrl);
    if (!videoId) {
      res.status(400).end();
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      const initial = await sampleAccurateLiveVideo(videoId, true);
      const stream = streamStore.get(videoId);
      if (stream) {
        stream.sseClients.add(res);
      }
      const latestTick = initial.history[initial.history.length - 1];
      res.write(
        `data: ${JSON.stringify({
          videoId,
          views: initial.views,
          probeRttMs: initial.probeRttMs,
          verifiedSources: initial.verifiedSources,
          fetchedAt: initial.fetchedAt,
          tick: latestTick,
        })}\n\n`
      );
    } catch {
      res.end();
      return;
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const stream = streamStore.get(videoId);
      if (stream) {
        stream.sseClients.delete(res);
      }
    });
  });

  // Lightweight 24/7 External Cron Ping Endpoint (for cron-job.org / UptimeRobot)
  app.get('/api/youtube/cron', async (req, res) => {
    try {
      const rawUrl = String(req.query.url || 'u3vex1jIlAM').trim();
      const videoId = extractVideoId(rawUrl);
      if (!videoId) {
        res.status(400).json({ ok: false, error: 'Invalid videoId' });
        return;
      }
      const data = await sampleAccurateLiveVideo(videoId, true);
      persistStreamsThrottled(true);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        videoId: data.videoId,
        views: data.views,
        fetchedAt: data.fetchedAt,
        recordedServerTicks: data.history.length,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Cron probe failed' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
