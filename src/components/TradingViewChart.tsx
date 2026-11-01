import React, { useMemo, useRef, useState } from 'react';
import type { ViewTick } from '../types/youtube';
import {
  formatDecimal,
  formatInt,
  formatSignedInt,
  formatWIBDateTime,
  formatWIBTime,
} from '../utils/formatters';

export type TimeframeOption = '2M' | '5M' | '15M' | '1H' | '6H' | '24H' | 'ORIGIN';
export type CurveStyle = 'step' | 'linear' | 'smooth';

interface TradingViewChartProps {
  ticks: ViewTick[];
  publishedAt: string | null;
  timeframe: TimeframeOption;
  curveStyle: CurveStyle;
  showEma: boolean;
}

interface PlottedPoint {
  epochMs: number;
  views: number;
  delta: number;
  ema: number;
  x: number;
  y: number;
}

function chooseNiceClockStepMs(spanMs: number): number {
  const candidates = [
    5_000,
    10_000,
    15_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    2 * 3_600_000,
    4 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    24 * 3_600_000,
  ];
  const target = Math.max(5_000, spanMs / 6);
  for (const step of candidates) {
    if (step >= target) return step;
  }
  return 24 * 3_600_000;
}

export function TradingViewChart({
  ticks,
  publishedAt,
  timeframe,
  curveStyle,
  showEma,
}: TradingViewChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Filter series and compute TRUE millisecond X-axis bounds [xMinMs, xMaxMs]
  const { activeSeries, xMinMs, xMaxMs } = useMemo(() => {
    if (ticks.length === 0) {
      const now = Date.now();
      return { activeSeries: [] as ViewTick[], xMinMs: now - 120_000, xMaxMs: now };
    }

    const latestMs = ticks[ticks.length - 1].epochMs;

    if (timeframe === 'ORIGIN') {
      const pubMs = publishedAt ? new Date(publishedAt).getTime() : NaN;
      if (!Number.isNaN(pubMs) && pubMs < ticks[0].epochMs - 5_000) {
        const withOrigin: ViewTick[] = [
          {
            timestamp: new Date(pubMs).toISOString(),
            epochMs: pubMs,
            views: 0,
          },
          ...ticks,
        ];
        return {
          activeSeries: withOrigin,
          xMinMs: pubMs,
          xMaxMs: Math.max(latestMs, pubMs + 10_000),
        };
      }
      return {
        activeSeries: ticks,
        xMinMs: ticks[0].epochMs,
        xMaxMs: Math.max(latestMs, ticks[0].epochMs + 10_000),
      };
    }

    const windowMap: Record<Exclude<TimeframeOption, 'ORIGIN'>, number> = {
      '2M': 2 * 60_000,
      '5M': 5 * 60_000,
      '15M': 15 * 60_000,
      '1H': 60 * 60_000,
      '6H': 6 * 3_600_000,
      '24H': 24 * 3_600_000,
    };

    const targetWindowMs = windowMap[timeframe];
    const cutoffMs = latestMs - targetWindowMs;

    // Include one anchor point immediately preceding cutoffMs so the curve enters cleanly from the left edge
    let firstInsideIdx = ticks.findIndex((t) => t.epochMs >= cutoffMs);
    if (firstInsideIdx === -1) firstInsideIdx = ticks.length - 1;
    const sliceStartIdx = Math.max(0, firstInsideIdx - 1);
    const sliced = ticks.slice(sliceStartIdx);

    // Clamp left bound to actual earliest data if recording started more recently than the window
    const earliestAvailableMs = ticks[0].epochMs;
    const effectiveMinMs = Math.max(cutoffMs, earliestAvailableMs);
    const effectiveMaxMs = Math.max(latestMs, effectiveMinMs + 10_000);

    return {
      activeSeries: sliced,
      xMinMs: effectiveMinMs,
      xMaxMs: effectiveMaxMs,
    };
  }, [ticks, timeframe, publishedAt]);

  // SVG Coordinate System
  const W = 1120;
  const H = 480;
  const PAD_LEFT = 18;
  const PAD_RIGHT = 94;
  const PAD_TOP = 28;
  const MAIN_BOTTOM = 356;
  const VOL_TOP = 372;
  const VOL_BOTTOM = 438;

  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = MAIN_BOTTOM - PAD_TOP;

  // Strict Integer Y-Axis Scale (Zero Fractional Views)
  const { yMin, yMax, yTicks } = useMemo(() => {
    if (activeSeries.length === 0) {
      return { yMin: 0, yMax: 10, yTicks: [0, 2, 4, 6, 8, 10] };
    }
    const vals = activeSeries.map((p) => p.views);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);

    if (rawMin === rawMax) {
      const margin = Math.max(2, Math.ceil(rawMax * 0.1));
      const low = Math.max(0, rawMin - margin);
      const high = rawMax + margin;
      const step = Math.max(1, Math.ceil((high - low) / 5));
      const grid: number[] = [];
      for (let v = low; v <= high; v += step) grid.push(v);
      return { yMin: low, yMax: grid[grid.length - 1] ?? high, yTicks: grid };
    }

    const span = rawMax - rawMin;
    const paddedMin = Math.max(0, Math.floor(rawMin - span * 0.12));
    const paddedMax = Math.ceil(rawMax + span * 0.15);
    const rawStep = Math.max(1, (paddedMax - paddedMin) / 5);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / magnitude;
    const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const step = Math.max(1, Math.round(niceMult * magnitude));

    const niceMin = Math.floor(paddedMin / step) * step;
    const niceMax = Math.ceil(paddedMax / step) * step;
    const grid: number[] = [];
    for (let v = niceMin; v <= niceMax; v += step) {
      grid.push(v);
    }
    return {
      yMin: niceMin,
      yMax: Math.max(niceMax, niceMin + 1),
      yTicks: grid,
    };
  }, [activeSeries]);

  const xSpanMs = Math.max(1_000, xMaxMs - xMinMs);
  const xForMs = (ms: number) => {
    const clamped = Math.max(xMinMs, Math.min(xMaxMs, ms));
    return PAD_LEFT + ((clamped - xMinMs) / xSpanMs) * plotW;
  };
  const yForValue = (val: number) =>
    MAIN_BOTTOM - ((val - yMin) / Math.max(1, yMax - yMin)) * plotH;

  // Map activeSeries to exact time-proportional coordinates
  const points = useMemo<PlottedPoint[]>(() => {
    if (activeSeries.length === 0) return [];
    const k = 2 / (5 + 1);
    let prevEma = activeSeries[0].views;

    return activeSeries.map((pt, idx) => {
      const ema = idx === 0 ? pt.views : pt.views * k + prevEma * (1 - k);
      prevEma = ema;
      const delta = idx === 0 ? 0 : pt.views - activeSeries[idx - 1].views;

      return {
        epochMs: pt.epochMs,
        views: pt.views,
        delta,
        ema,
        x: xForMs(pt.epochMs),
        y: yForValue(pt.views),
      };
    });
  }, [activeSeries, xMinMs, xMaxMs, yMin, yMax]);

  // Exact Wall-Clock Boundary X-Axis Gridlines
  const clockGridMarks = useMemo(() => {
    const stepMs = chooseNiceClockStepMs(xSpanMs);
    const firstTickMs = Math.ceil(xMinMs / stepMs) * stepMs;
    const marks: { ms: number; x: number }[] = [];
    for (let t = firstTickMs; t <= xMaxMs; t += stepMs) {
      marks.push({ ms: t, x: xForMs(t) });
    }
    if (marks.length === 0) {
      marks.push({ ms: xMinMs, x: PAD_LEFT });
      marks.push({ ms: xMaxMs, x: PAD_LEFT + plotW });
    }
    return marks;
  }, [xMinMs, xMaxMs, xSpanMs, plotW]);

  // Build exact SVG paths
  const { linePath, areaPath, emaPath } = useMemo(() => {
    if (points.length === 0) {
      return { linePath: '', areaPath: '', emaPath: '' };
    }
    if (points.length === 1) {
      const p = points[0];
      const singleLine = `M ${PAD_LEFT} ${p.y} L ${PAD_LEFT + plotW} ${p.y}`;
      const singleArea = `${singleLine} L ${PAD_LEFT + plotW} ${MAIN_BOTTOM} L ${PAD_LEFT} ${MAIN_BOTTOM} Z`;
      return { linePath: singleLine, areaPath: singleArea, emaPath: singleLine };
    }

    let d = '';
    if (curveStyle === 'step') {
      // Exact Step-After: holds exact integer views horizontally until exact timestamp of next observation
      d = points
        .map((p, idx) => {
          if (idx === 0) return `M ${p.x} ${p.y}`;
          const prev = points[idx - 1];
          return `L ${p.x} ${prev.y} L ${p.x} ${p.y}`;
        })
        .join(' ');
    } else if (curveStyle === 'linear') {
      // Exact Point-to-Point Linear Slope: zero curve distortion
      d = points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    } else {
      // Zero-overshoot monotone cubic Bezier
      d = points
        .map((p, idx) => {
          if (idx === 0) return `M ${p.x} ${p.y}`;
          const prev = points[idx - 1];
          const midX = (prev.x + p.x) / 2;
          return `C ${midX} ${prev.y}, ${midX} ${p.y}, ${p.x} ${p.y}`;
        })
        .join(' ');
    }

    const first = points[0];
    const last = points[points.length - 1];
    const area = `${d} L ${last.x} ${MAIN_BOTTOM} L ${first.x} ${MAIN_BOTTOM} Z`;

    const emaD = points
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${yForValue(p.ema)}`)
      .join(' ');

    return { linePath: d, areaPath: area, emaPath: emaD };
  }, [points, curveStyle, plotW, yMin, yMax]);

  const maxAbsDelta = useMemo(() => {
    if (points.length <= 1) return 1;
    return Math.max(...points.map((p) => Math.abs(p.delta)), 1);
  }, [points]);

  const handlePointerMove = (clientX: number) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W;
    const clampedX = Math.max(PAD_LEFT, Math.min(PAD_LEFT + plotW, relX));

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(points[i].x - clampedX);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    setHoverIndex(bestIdx);
  };

  const firstPt = points[0];
  const latestPt = points[points.length - 1];
  const inspectedPt =
    hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : latestPt;

  // Window velocity (views / hour) across visible window
  const windowVelocityPerHour = useMemo(() => {
    if (!firstPt || !latestPt) return 0;
    const dtHours = (latestPt.epochMs - firstPt.epochMs) / 3_600_000;
    if (dtHours < 1 / 3600) return 0;
    return (latestPt.views - firstPt.views) / dtHours;
  }, [firstPt, latestPt]);

  const isTrendDown = firstPt && latestPt ? latestPt.views < firstPt.views : false;
  const strokeColor = isTrendDown ? '#ef4444' : '#10b981';
  const showSampleDots = points.length <= 80;

  return (
    <div className="relative bg-[#090E1A] border border-slate-800 rounded-xl overflow-hidden select-none">
      {/* Precision Readout Header */}
      {inspectedPt && (
        <div className="px-4 py-2.5 border-b border-slate-800/80 bg-slate-950/60 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-slate-400">
              Waktu:{' '}
              <strong className="text-slate-200 font-medium">
                {xSpanMs > 12 * 3_600_000
                  ? formatWIBDateTime(inspectedPt.epochMs)
                  : `${formatWIBTime(inspectedPt.epochMs)} WIB`}
              </strong>
            </span>
            <span className="text-slate-400">
              Total Tayangan:{' '}
              <strong className="text-emerald-400 font-semibold">
                {formatInt(inspectedPt.views)}
              </strong>
            </span>
            <span className="text-slate-400">
              Perubahan Tick:{' '}
              <strong
                className={
                  inspectedPt.delta > 0
                    ? 'text-emerald-400 font-semibold'
                    : inspectedPt.delta < 0
                      ? 'text-red-400 font-semibold'
                      : 'text-slate-300 font-medium'
                }
              >
                {formatSignedInt(inspectedPt.delta)}
              </strong>
            </span>
            <span className="text-slate-400">
              Laju Jendela:{' '}
              <strong className="text-slate-200 font-medium">
                {formatDecimal(windowVelocityPerHour, 1)}/jam
              </strong>
            </span>
            {showEma && (
              <span className="text-amber-400/90">
                Rata-rata Bergerak (5): <strong>{formatDecimal(inspectedPt.ema, 2)}</strong>
              </span>
            )}
          </div>

          <div className="text-slate-500">
            Skala waktu proporsional · {formatInt(points.length)} sampel
          </div>
        </div>
      )}

      {/* Main Trading SVG Viewport */}
      <div className="w-full">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[380px] sm:h-[460px] block cursor-crosshair touch-none"
          role="img"
          aria-label="Grafik kurva presisi total tayangan YouTube"
          onMouseMove={(e) => handlePointerMove(e.clientX)}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchMove={(e) => {
            if (e.touches[0]) handlePointerMove(e.touches[0].clientX);
          }}
          onTouchEnd={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="tradingAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.24" />
              <stop offset="80%" stopColor={strokeColor} stopOpacity="0.03" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* True Wall-Clock Vertical Gridlines & X-Axis Labels */}
          {clockGridMarks.map((mark) => (
            <g key={`xgrid-${mark.ms}`}>
              <line
                x1={mark.x}
                y1={PAD_TOP}
                x2={mark.x}
                y2={VOL_BOTTOM}
                stroke="#162032"
                strokeWidth="1"
              />
              <text
                x={mark.x}
                y={H - 14}
                textAnchor="middle"
                className="fill-slate-500 text-[11px] font-mono tabular-nums"
              >
                {formatWIBTime(mark.ms)}
              </text>
            </g>
          ))}

          {/* Exact Integer Horizontal Y-Axis Gridlines & Right-Hand Scale */}
          {yTicks.map((val) => {
            const y = yForValue(val);
            return (
              <g key={`ygrid-${val}`}>
                <line
                  x1={PAD_LEFT}
                  y1={y}
                  x2={W - PAD_RIGHT}
                  y2={y}
                  stroke="#162032"
                  strokeWidth="1"
                />
                <text
                  x={W - PAD_RIGHT + 10}
                  y={y + 4}
                  textAnchor="start"
                  className="fill-slate-400 text-[11px] font-mono tabular-nums"
                >
                  {formatInt(val)}
                </text>
              </g>
            );
          })}

          {/* Axis Structural Borders */}
          <line
            x1={W - PAD_RIGHT}
            y1={0}
            x2={W - PAD_RIGHT}
            y2={H - 34}
            stroke="#1e293b"
            strokeWidth="1"
          />
          <line
            x1={0}
            y1={VOL_BOTTOM}
            x2={W}
            y2={VOL_BOTTOM}
            stroke="#1e293b"
            strokeWidth="1"
          />
          <line
            x1={PAD_LEFT}
            y1={VOL_TOP - 8}
            x2={W - PAD_RIGHT}
            y2={VOL_TOP - 8}
            stroke="#162032"
            strokeWidth="1"
          />
          <text
            x={PAD_LEFT + 4}
            y={VOL_TOP + 6}
            className="fill-slate-500 text-[10px] font-mono"
          >
            Delta per Tick
          </text>

          {/* Area Fill & Main Precision Curve */}
          {areaPath && <path d={areaPath} fill="url(#tradingAreaGrad)" />}

          {showEma && emaPath && points.length >= 2 && (
            <path
              d={emaPath}
              fill="none"
              stroke="#f59e0b"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              opacity="0.85"
            />
          )}

          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={strokeColor}
              strokeWidth="2.2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Exact Data Sample Vertices when <= 80 points */}
          {showSampleDots &&
            points.map((pt, idx) => (
              <circle
                key={`dot-${pt.epochMs}-${idx}`}
                cx={pt.x}
                cy={pt.y}
                r={2.2}
                fill={strokeColor}
              />
            ))}

          {/* Bottom Delta Histogram Bars */}
          {points.map((pt, idx) => {
            const barW = 4;
            const maxBarH = VOL_BOTTOM - VOL_TOP - 8;
            const barH =
              pt.delta === 0
                ? 2
                : Math.max(5, (Math.abs(pt.delta) / maxAbsDelta) * maxBarH);
            const barColor =
              pt.delta > 0
                ? 'rgba(16, 185, 129, 0.65)'
                : pt.delta < 0
                  ? 'rgba(239, 68, 68, 0.65)'
                  : 'rgba(71, 85, 105, 0.3)';

            return (
              <rect
                key={`vol-${pt.epochMs}-${idx}`}
                x={pt.x - barW / 2}
                y={VOL_BOTTOM - barH}
                width={barW}
                height={barH}
                rx={1}
                fill={barColor}
              />
            );
          })}

          {/* Horizontal Current Level Line + Right-Axis Pinned Price Tag */}
          {latestPt && (
            <g>
              <line
                x1={PAD_LEFT}
                y1={latestPt.y}
                x2={W - PAD_RIGHT}
                y2={latestPt.y}
                stroke={strokeColor}
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.7"
              />
              <circle
                cx={latestPt.x}
                cy={latestPt.y}
                r={4.5}
                fill={strokeColor}
                stroke="#090E1A"
                strokeWidth="2"
              />
              <rect
                x={W - PAD_RIGHT + 1}
                y={latestPt.y - 11}
                width={PAD_RIGHT - 5}
                height={22}
                rx={3}
                fill={strokeColor}
              />
              <text
                x={W - PAD_RIGHT + 10}
                y={latestPt.y + 4}
                textAnchor="start"
                className="fill-slate-950 text-[11px] font-mono font-bold tabular-nums"
              >
                {formatInt(latestPt.views)}
              </text>
            </g>
          )}

          {/* Interactive Crosshair & Axis Callout Tags */}
          {hoverIndex !== null && inspectedPt && (
            <g pointerEvents="none">
              <line
                x1={inspectedPt.x}
                y1={PAD_TOP}
                x2={inspectedPt.x}
                y2={VOL_BOTTOM}
                stroke="#94a3b8"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              <line
                x1={PAD_LEFT}
                y1={inspectedPt.y}
                x2={W - PAD_RIGHT}
                y2={inspectedPt.y}
                stroke="#94a3b8"
                strokeWidth="1"
                strokeDasharray="4 4"
              />

              <circle
                cx={inspectedPt.x}
                cy={inspectedPt.y}
                r={5.5}
                fill="#090E1A"
                stroke="#f8fafc"
                strokeWidth="2"
              />

              <rect
                x={W - PAD_RIGHT + 1}
                y={inspectedPt.y - 11}
                width={PAD_RIGHT - 5}
                height={22}
                rx={3}
                fill="#334155"
              />
              <text
                x={W - PAD_RIGHT + 10}
                y={inspectedPt.y + 4}
                textAnchor="start"
                className="fill-white text-[11px] font-mono font-semibold tabular-nums"
              >
                {formatInt(inspectedPt.views)}
              </text>

              <rect
                x={Math.max(4, Math.min(W - PAD_RIGHT - 86, inspectedPt.x - 43))}
                y={VOL_BOTTOM + 4}
                width={86}
                height={22}
                rx={3}
                fill="#334155"
              />
              <text
                x={Math.max(47, Math.min(W - PAD_RIGHT - 43, inspectedPt.x))}
                y={VOL_BOTTOM + 19}
                textAnchor="middle"
                className="fill-white text-[11px] font-mono font-medium tabular-nums"
              >
                {formatWIBTime(inspectedPt.epochMs)}
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
