import { Cloud, Download, LogOut } from 'lucide-react';
import type { User } from 'firebase/auth';

interface NavbarProps {
  videoUrl: string | null;
  onOpen24hGuide: () => void;
  onExportCsv: () => void;
  canExport: boolean;
  user: User | null;
  isAuthBusy: boolean;
  onSignInCloud: () => void;
  onSignOutCloud: () => void;
}

export function Navbar({
  videoUrl,
  onOpen24hGuide,
  onExportCsv,
  canExport,
  user,
  isAuthBusy,
  onSignInCloud,
  onSignOutCloud,
}: NavbarProps) {
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-8 px-4 sm:px-6 h-14">
        {/* Zone 1: Single wordmark */}
        <a
          href="/"
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          PantauView
        </a>

        {/* Zone 2: Clean single-line text links */}
        <nav
          aria-label="Navigasi utama"
          className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-400"
        >
          <button
            type="button"
            onClick={onOpen24hGuide}
            className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Mode Rekam 24 Jam
          </button>
          <button
            type="button"
            onClick={onExportCsv}
            disabled={!canExport}
            className="hover:text-slate-100 hover:underline underline-offset-4 disabled:opacity-40 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Unduh CSV</span>
          </button>
          {videoUrl && (
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Buka di YouTube
            </a>
          )}
        </nav>

        {/* Zone 3: 1 primary Cloud Sync action */}
        <div className="flex items-center shrink-0">
          {user ? (
            <button
              type="button"
              onClick={onSignOutCloud}
              title="Klik untuk keluar dari sinkronisasi Cloud"
              className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Cloud Aktif</span>
              <LogOut className="w-3 h-3 text-slate-400 ml-0.5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignInCloud}
              disabled={isAuthBusy}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isAuthBusy ? 'Menghubungkan...' : 'Simpan Permanen (Cloud)'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
