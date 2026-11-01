import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  Check,
  Cloud,
  Copy,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Navbar } from './components/Navbar';
import {
  type CurveStyle,
  type TimeframeOption,
  TradingViewChart,
} from './components/TradingViewChart';
import {
  clearCloudTicksForVideo,
  ensureParentWatchedVideoDoc,
  loadCloudTicksForVideo,
  selectSignificantCloudTicks,
  signInWithGooglePopup,
  signOutUser,
  subscribeAuth,
  syncUnsyncedTicksToCloud,
} from './lib/firebase';
import type { LiveViewResponse, ViewTick } from './types/youtube';
import {
  exportTicksToCsv,
  formatInt,
  formatSignedInt,
  formatSignedPercent,
  formatWIBTime,
  mergeTicks,
} from './utils/formatters';

const DEFAULT_URL = 'https://youtu.be/u3vex1jIlAM?si=elfOCT-f-GV8-KUM';
const DEFAULT_VIDEO_ID = 'u3vex1jIlAM';

type StreamMode = 'SSE' | '5S' | '15S' | 'PAUSED';

function loadLocalTicks(videoId: string): ViewTick[] {
  try {
    const raw = localStorage.getItem(`pantauview_ticks_v3_${videoId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalTicks(videoId: string, ticks: ViewTick[]): void {
  try {
    localStorage.setItem(
      `pantauview_ticks_v3_${videoId}`,
      JSON.stringify(ticks.slice(-1500))
    );
  } catch {
    // Ignore storage quota errors
  }
}

export default function App() {
  const [urlInput, setUrlInput] = useState<string>(DEFAULT_URL);
  const [activeTarget, setActiveTarget] = useState<string>(DEFAULT_URL);
  const [data, setData] = useState<LiveViewResponse | null>(null);
  const [ticks, setTicks] = useState<ViewTick[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState<boolean>(false);

  // Firebase Cloud Persistence State
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [isAuthBusy, setIsAuthBusy] = useState<boolean>(false);
  const [cloudSavedCount, setCloudSavedCount] = useState<number>(0);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);

  // 24h Nonstop Recording Guide Panel
  const [show24hGuide, setShow24hGuide] = useState<boolean>(false);
  const [copiedCron, setCopiedCron] = useState<boolean>(false);

  // Precision Trading Chart Controls
  const [streamMode, setStreamMode] = useState<StreamMode>('SSE');
  const [timeframe, setTimeframe] = useState<TimeframeOption>('15M');
  const [curveStyle, setCurveStyle] = useState<CurveStyle>('step');
  const [showEma, setShowEma] = useState<boolean>(false);

  const syncedTickIdsRef = useRef<Set<string>>(new Set());
  const parentDocIdRef = useRef<string | null>(null);
  const loadedCloudKeyRef = useRef<string | null>(null);
  const cloudSyncBusyRef = useRef<boolean>(false);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsub = subscribeAuth((u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  const fetchSnapshot = useCallback(
    async (targetUrl: string, isBackground = false) => {
      if (!isBackground && !data) {
        setIsInitialLoading(true);
      } else {
        setIsSyncing(true);
      }
      if (!isBackground) {
        setErrorMessage(null);
      }

      try {
        const res = await fetch(
          `/api/youtube/live?url=${encodeURIComponent(targetUrl)}`
        );
        const payload = await res.json();
        if (!res.ok) {
          throw new Error(payload?.error || 'Gagal memuat data tayangan YouTube.');
        }

        const liveData = payload as LiveViewResponse;
        setData((prev) => {
          if (prev?.videoId !== liveData.videoId) {
            setAvatarFailed(false);
            parentDocIdRef.current = null;
          }
          return liveData;
        });

        setTicks((prevTicks) => {
          const base =
            data?.videoId === liveData.videoId
              ? prevTicks
              : loadLocalTicks(liveData.videoId);
          const merged = mergeTicks(base, liveData.history);
          saveLocalTicks(liveData.videoId, merged);
          return merged;
        });

        setErrorMessage(null);
      } catch (err: any) {
        if (!isBackground || !data) {
          setErrorMessage(
            err?.message || 'Tidak dapat mengambil tayangan real-time saat ini.'
          );
        }
      } finally {
        setIsInitialLoading(false);
        setIsSyncing(false);
      }
    },
    [data]
  );

  // Initial load
  useEffect(() => {
    fetchSnapshot(DEFAULT_URL, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time SSE push stream OR fallback interval polling
  useEffect(() => {
    if (!activeTarget || streamMode === 'PAUSED') return;

    if (streamMode === 'SSE') {
      const es = new EventSource(
        `/api/youtube/stream?url=${encodeURIComponent(activeTarget)}`
      );

      es.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as {
            videoId: string;
            views: number;
            probeRttMs: number;
            verifiedSources: number;
            fetchedAt: string;
            tick?: ViewTick;
          };

          setData((prev) => {
            if (!prev || prev.videoId !== msg.videoId) return prev;
            return {
              ...prev,
              views: msg.views,
              probeRttMs: msg.probeRttMs,
              verifiedSources: msg.verifiedSources,
              fetchedAt: msg.fetchedAt,
            };
          });

          if (msg.tick) {
            const incomingTick = msg.tick;
            setTicks((prev) => {
              const merged = mergeTicks(prev, [incomingTick]);
              saveLocalTicks(msg.videoId, merged);
              return merged;
            });
          }
        } catch {
          // Ignore malformed event
        }
      };

      return () => {
        es.close();
      };
    }

    const intervalMs = streamMode === '5S' ? 5_000 : 15_000;
    const timer = window.setInterval(() => {
      fetchSnapshot(activeTarget, true);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [activeTarget, streamMode, fetchSnapshot]);

  // Load existing Cloud Firestore history whenever (user, videoId) pair becomes active
  useEffect(() => {
    if (!authReady || !user || !data) {
      loadedCloudKeyRef.current = null;
      syncedTickIdsRef.current = new Set();
      parentDocIdRef.current = null;
      setCloudSavedCount(0);
      return;
    }

    const cloudKey = `${user.uid}_${data.videoId}`;
    if (loadedCloudKeyRef.current === cloudKey) return;
    loadedCloudKeyRef.current = cloudKey;

    let cancelled = false;
    (async () => {
      try {
        const { ticks: cloudTicks, syncedTickIds } = await loadCloudTicksForVideo(
          user.uid,
          data.videoId
        );
        if (cancelled) return;
        syncedTickIdsRef.current = syncedTickIds;
        setCloudSavedCount(syncedTickIds.size);

        if (cloudTicks.length > 0) {
          setTicks((prev) => {
            const merged = mergeTicks(cloudTicks, prev);
            saveLocalTicks(data.videoId, merged);
            return merged;
          });
        }
        setCloudNotice(null);
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg.includes('Quota exceeded')) {
          setCloudNotice(
            'Kuota harian gratis Firestore telah tercapai dan akan di-reset besok.'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authReady, user, data]);

  // Continuously persist new significant ticks to Cloud Firestore when authenticated
  useEffect(() => {
    if (!authReady || !user || !data || ticks.length === 0) return;
    const cloudKey = `${user.uid}_${data.videoId}`;
    if (loadedCloudKeyRef.current !== cloudKey || cloudSyncBusyRef.current) return;

    const unsynced = selectSignificantCloudTicks(ticks, syncedTickIdsRef.current);
    if (unsynced.length === 0) return;

    cloudSyncBusyRef.current = true;
    (async () => {
      try {
        let docId = parentDocIdRef.current;
        if (!docId) {
          docId = await ensureParentWatchedVideoDoc(user.uid, data);
          parentDocIdRef.current = docId;
        }
        await syncUnsyncedTicksToCloud(
          user.uid,
          data.videoId,
          docId,
          unsynced,
          syncedTickIdsRef.current
        );
        setCloudSavedCount(syncedTickIdsRef.current.size);
        setCloudNotice(null);
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (msg.includes('Quota exceeded')) {
          setCloudNotice(
            'Kuota harian gratis Firestore telah tercapai dan akan di-reset besok.'
          );
        }
      } finally {
        cloudSyncBusyRef.current = false;
      }
    })();
  }, [authReady, user, data, ticks]);

  const handleSignInCloud = async () => {
    setIsAuthBusy(true);
    setCloudNotice(null);
    try {
      await signInWithGooglePopup();
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setCloudNotice('Gagal masuk dengan Google. Pastikan popup diizinkan di browser.');
      }
    } finally {
      setIsAuthBusy(false);
    }
  };

  const handleSignOutCloud = async () => {
    await signOutUser();
    setCloudSavedCount(0);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = urlInput.trim();
    if (!cleaned) return;
    setActiveTarget(cleaned);
    fetchSnapshot(cleaned, false);
  };

  const handleRestoreDefault = () => {
    setUrlInput(DEFAULT_URL);
    setActiveTarget(DEFAULT_URL);
    fetchSnapshot(DEFAULT_URL, false);
  };

  const handleResetSessionTicks = async () => {
    if (!data) return;
    const nowMs = Date.now();
    const fresh: ViewTick[] = [
      {
        timestamp: new Date(nowMs).toISOString(),
        epochMs: nowMs,
        views: data.views,
      },
    ];
    saveLocalTicks(data.videoId, fresh);
    setTicks(fresh);

    if (user) {
      try {
        await clearCloudTicksForVideo(user.uid, data.videoId, syncedTickIdsRef.current);
        setCloudSavedCount(0);
      } catch {
        // Ignore cloud delete error
      }
    }
  };

  const cronEndpointUrl = useMemo(() => {
    const vid = data?.videoId || DEFAULT_VIDEO_ID;
    return `${window.location.origin}/api/youtube/cron?url=${encodeURIComponent(vid)}`;
  }, [data?.videoId]);

  const handleCopyCronUrl = async () => {
    try {
      await navigator.clipboard.writeText(cronEndpointUrl);
      setCopiedCron(true);
      setTimeout(() => setCopiedCron(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const sessionStats = useMemo(() => {
    if (ticks.length === 0) {
      const current = data?.views ?? 0;
      return { open: current, high: current, low: current, change: 0, changePct: 0 };
    }
    const open = ticks[0].views;
    const current = ticks[ticks.length - 1].views;
    let high = open;
    let low = open;
    for (const t of ticks) {
      if (t.views > high) high = t.views;
      if (t.views < low) low = t.views;
    }
    const change = current - open;
    const changePct = open > 0 ? (change / open) * 100 : 0;
    return { open, high, low, change, changePct };
  }, [ticks, data]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Navbar
        videoUrl={data?.canonicalUrl ?? null}
        onOpen24hGuide={() => setShow24hGuide((prev) => !prev)}
        canExport={Boolean(data && ticks.length > 0)}
        onExportCsv={() => {
          if (data) exportTicksToCsv(data, ticks);
        }}
        user={user}
        isAuthBusy={isAuthBusy}
        onSignInCloud={handleSignInCloud}
        onSignOutCloud={handleSignOutCloud}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* Cloud Quota / Auth Feedback Notice */}
        {cloudNotice && (
          <div className="bg-slate-900 border border-amber-800/60 rounded-xl px-4 py-3 flex items-center justify-between gap-3 text-xs text-amber-200">
            <span>{cloudNotice}</span>
            <button
              type="button"
              onClick={() => setCloudNotice(null)}
              className="text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Collapsible 24-Hour Nonstop Cloud + Cron Guide */}
        {show24hGuide && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-slate-100">
                  Pengaturan Penyimpanan Permanen & Rekam 24 Jam Nonstop
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">
                  Agar riwayat kurva tidak pernah hilang dan tetap merekam meski semua tab HP/laptop ditutup semalaman, aktifkan dua langkah berikut:
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShow24hGuide(false)}
                className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1 cursor-pointer"
              >
                <span>Tutup</span>
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800">
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-200">
                  1. Database Permanen Cloud Firestore
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {user
                    ? `Terhubung ke akun Google Anda (${formatInt(cloudSavedCount)} titik penting telah disinkronkan permanen ke Cloud Firestore). Data kurva aman dibuka dari perangkat mana pun.`
                    : 'Klik tombol "Simpan Permanen (Cloud)" di pojok kanan atas untuk menyimpan seluruh riwayat kurva ke database Firebase Anda.'}
                </p>
                {!user && (
                  <button
                    type="button"
                    onClick={handleSignInCloud}
                    disabled={isAuthBusy}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Hubungkan Akun Google Sekarang</span>
                  </button>
                )}
              </div>

              <div className="space-y-2 md:border-l md:border-slate-800 md:pl-5">
                <div className="text-xs font-semibold text-slate-200">
                  2. URL Pemicu Otomatis Saat Tab Ditutup (Opsional · Gratis)
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Tempel URL di bawah ke layanan gratis seperti <strong>cron-job.org</strong> atau <strong>UptimeRobot</strong> (interval 1–5 menit) agar server tetap bangun merekam 24/7 saat browser Anda mati:
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={cronEndpointUrl}
                    aria-label="URL Cron 24 Jam"
                    className="flex-1 h-8 px-2.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-md text-slate-300"
                  />
                  <button
                    type="button"
                    onClick={handleCopyCronUrl}
                    className="h-8 px-3 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedCron ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Salin URL</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Compact URL & High-Precision Stream Mode Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-3">
          <form onSubmit={handleSubmit} className="flex-1 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search
                className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Masukkan link video YouTube (youtu.be/... atau youtube.com/watch?v=...)"
                aria-label="Tautan video YouTube"
                className="w-full h-9 pl-9 pr-3 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={isSyncing && isInitialLoading}
              className="h-9 px-4 text-xs font-semibold text-slate-950 bg-slate-100 hover:bg-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Pantau Video
            </button>
            {data && data.videoId !== DEFAULT_VIDEO_ID && (
              <button
                type="button"
                onClick={handleRestoreDefault}
                className="h-9 px-3 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Video Awal</span>
              </button>
            )}
          </form>

          <div className="flex flex-wrap items-center justify-between lg:justify-end gap-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 whitespace-nowrap">Mode Stream:</span>
              <div
                role="group"
                aria-label="Mode pembacaan real-time"
                className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg"
              >
                {(
                  [
                    { id: 'SSE', label: 'Push ~2.5d' },
                    { id: '5S', label: '5d' },
                    { id: '15S', label: '15d' },
                    { id: 'PAUSED', label: 'Jeda' },
                  ] as { id: StreamMode; label: string }[]
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setStreamMode(m.id)}
                    className={`px-2.5 py-1 text-xs font-mono tabular-nums rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      streamMode === m.id
                        ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => fetchSnapshot(activeTarget, true)}
              disabled={isSyncing}
              className="h-8 px-2.5 text-xs font-medium text-slate-300 bg-slate-950 border border-slate-800 hover:border-slate-700 hover:text-white rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-emerald-400' : ''}`}
                aria-hidden="true"
              />
              <span>Cek Sekarang</span>
            </button>
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            className="bg-slate-900 border border-red-900/70 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" />
              <div className="text-xs sm:text-sm text-slate-200">{errorMessage}</div>
            </div>
            <button
              type="button"
              onClick={() => fetchSnapshot(activeTarget, false)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-950 bg-slate-100 hover:bg-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              Coba Lagi
            </button>
          </div>
        )}

        {/* Loading Skeleton */}
        {isInitialLoading && !data ? (
          <div className="space-y-4 animate-pulse" aria-busy="true">
            <div className="h-24 bg-slate-900 border border-slate-800 rounded-xl" />
            <div className="h-[510px] bg-slate-900 border border-slate-800 rounded-xl" />
            <div className="h-20 bg-slate-900 border border-slate-800 rounded-xl" />
          </div>
        ) : data ? (
          <>
            {/* Trading Ticker Header */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
              <div className="min-w-0 space-y-2">
                {/* Unboxed Metadata Line */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                  <div className="inline-flex items-center gap-2 text-slate-200 font-medium">
                    {data.avatarUrl && !avatarFailed ? (
                      <img
                        src={data.avatarUrl}
                        alt={data.channelName}
                        referrerPolicy="no-referrer"
                        onError={() => setAvatarFailed(true)}
                        className="w-5 h-5 rounded-full object-cover border border-slate-700"
                      />
                    ) : (
                      <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 inline-flex items-center justify-center text-[10px] font-bold">
                        {data.channelName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span>{data.channelName}</span>
                  </div>
                  {data.channelHandle && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{data.channelHandle}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">YT:{data.videoId}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {formatWIBTime(data.fetchedAt)} WIB ({data.probeRttMs} ms ·{' '}
                    {data.verifiedSources} sumber YouTube)
                  </span>
                  {user && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-400 font-mono tabular-nums">
                        Cloud: {formatInt(cloudSavedCount)} tersimpan
                      </span>
                    </>
                  )}
                </div>

                <h1
                  className="text-lg sm:text-xl font-bold tracking-tight text-slate-100 leading-snug max-w-3xl"
                  style={{ textWrap: 'balance' }}
                >
                  {data.title}
                </h1>
              </div>

              {/* Focal Anchor: Exact Real-Time Total Views Counter */}
              <div className="flex flex-col lg:items-end shrink-0">
                <span className="text-xs font-medium text-slate-400">
                  Total Tayangan Eksak (Real-Time)
                </span>
                <div className="flex items-baseline gap-3 mt-0.5">
                  <span className="text-4xl sm:text-5xl font-bold font-mono tabular-nums tracking-tight text-white">
                    {formatInt(data.views)}
                  </span>
                  <span
                    className={`text-sm font-mono font-semibold tabular-nums ${
                      sessionStats.change > 0
                        ? 'text-emerald-400'
                        : sessionStats.change < 0
                          ? 'text-red-400'
                          : 'text-slate-400'
                    }`}
                  >
                    {formatSignedInt(sessionStats.change)} (
                    {formatSignedPercent(sessionStats.changePct)})
                  </span>
                </div>
              </div>
            </div>

            {/* Chart Toolbar: True Timeframe + Lossless Curve Mode + EMA */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Timeframe Selector */}
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
                {(
                  [
                    { id: '2M', label: '2M' },
                    { id: '5M', label: '5M' },
                    { id: '15M', label: '15M' },
                    { id: '1H', label: '1J' },
                    { id: '6H', label: '6J' },
                    { id: '24H', label: '24J' },
                    { id: 'ORIGIN', label: 'Sejak Rilis' },
                  ] as { id: TimeframeOption; label: string }[]
                ).map((tf) => (
                  <button
                    key={tf.id}
                    type="button"
                    onClick={() => setTimeframe(tf.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      timeframe === tf.id
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>

              {/* Precision Interpolation Mode & Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
                  {(
                    [
                      { id: 'step', label: 'Step Presisi' },
                      { id: 'linear', label: 'Linear Eksak' },
                      { id: 'smooth', label: 'Kurva Halus' },
                    ] as { id: CurveStyle; label: string }[]
                  ).map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setCurveStyle(st.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        curveStyle === st.id
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setShowEma((prev) => !prev)}
                  className={`h-8 px-3 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    showEma
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  EMA (5)
                </button>

                <button
                  type="button"
                  onClick={() => setShow24hGuide((prev) => !prev)}
                  className="md:hidden h-8 px-2.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Mode 24 Jam
                </button>

                {ticks.length > 2 && (
                  <button
                    type="button"
                    onClick={handleResetSessionTicks}
                    className="h-8 px-2.5 text-xs font-medium text-slate-400 bg-slate-900 border border-slate-800 hover:text-red-400 hover:border-red-900/60 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Reset</span>
                  </button>
                )}
              </div>
            </div>

            {/* Precision Trading Curve */}
            <TradingViewChart
              ticks={ticks}
              publishedAt={data.publishedAt}
              timeframe={timeframe}
              curveStyle={curveStyle}
              showEma={showEma}
            />

            {/* Session Trading Summary Strip (Open / High / Low / Change) */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 font-mono tabular-nums">
              <div className="p-4">
                <div className="text-xs font-sans text-slate-400">Awal Rekaman (Open)</div>
                <div className="text-lg font-semibold text-slate-100 mt-0.5">
                  {formatInt(sessionStats.open)}
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs font-sans text-slate-400">Tertinggi (High)</div>
                <div className="text-lg font-semibold text-emerald-400 mt-0.5">
                  {formatInt(sessionStats.high)}
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs font-sans text-slate-400">Terendah (Low)</div>
                <div className="text-lg font-semibold text-slate-200 mt-0.5">
                  {formatInt(sessionStats.low)}
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs font-sans text-slate-400">Perubahan Total</div>
                <div
                  className={`text-lg font-semibold mt-0.5 ${
                    sessionStats.change > 0
                      ? 'text-emerald-400'
                      : sessionStats.change < 0
                        ? 'text-red-400'
                        : 'text-slate-200'
                  }`}
                >
                  {formatSignedInt(sessionStats.change)} tayangan
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
