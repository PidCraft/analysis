import type { LiveViewResponse, ViewTick } from '../types/youtube';

const intFormatter = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 0,
});

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return intFormatter.format(Math.round(value));
}

export function formatSignedInt(value: number): string {
  const formatted = formatInt(Math.abs(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return '0';
}

export function formatDecimal(value: number, digits = 2): string {
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return '0,00%';
  const absStr = formatDecimal(Math.abs(value), 2);
  if (value > 0) return `+${absStr}%`;
  if (value < 0) return `-${absStr}%`;
  return `0,00%`;
}

export function formatWIBTime(epochMsOrIso: number | string): string {
  const d = typeof epochMsOrIso === 'number' ? new Date(epochMsOrIso) : new Date(epochMsOrIso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

export function formatWIBDateTime(epochMsOrIso: number | string | null): string {
  if (!epochMsOrIso) return '—';
  const d = typeof epochMsOrIso === 'number' ? new Date(epochMsOrIso) : new Date(epochMsOrIso);
  if (Number.isNaN(d.getTime())) return '—';
  const datePart = new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(d);
  return `${datePart} ${formatWIBTime(d.getTime())} WIB`;
}

export function mergeTicks(localTicks: ViewTick[], serverTicks: ViewTick[]): ViewTick[] {
  const map = new Map<number, ViewTick>();
  for (const t of localTicks) {
    if (t && typeof t.epochMs === 'number' && typeof t.views === 'number') {
      const bucket = Math.floor(t.epochMs / 1000);
      map.set(bucket, t);
    }
  }
  for (const t of serverTicks) {
    if (t && typeof t.epochMs === 'number' && typeof t.views === 'number') {
      const bucket = Math.floor(t.epochMs / 1000);
      map.set(bucket, t);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.epochMs - b.epochMs)
    .slice(-1000);
}

export function exportTicksToCsv(data: LiveViewResponse, ticks: ViewTick[]): void {
  const escapeCsv = (val: string | number) => {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines: string[] = [];
  lines.push('Waktu ISO,Waktu WIB,Video ID,Judul,Total Tayangan,Perubahan Tick');
  ticks.forEach((t, idx) => {
    const prev = idx > 0 ? ticks[idx - 1].views : t.views;
    const delta = idx > 0 ? t.views - prev : 0;
    lines.push(
      [
        escapeCsv(t.timestamp),
        escapeCsv(`${formatWIBTime(t.epochMs)} WIB`),
        escapeCsv(data.videoId),
        escapeCsv(data.title),
        escapeCsv(t.views),
        escapeCsv(delta),
      ].join(',')
    );
  });

  const blob = new Blob(['\uFEFF' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tayangan-realtime-${data.videoId}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
