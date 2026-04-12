"use client";

import useSWR from "swr";
import { apiBaseUrl, fetcher } from "@/lib/api";

interface WalletEntry {
  icao: string;
  address: string;
  walletIndex: number;
  wocUrl: string;
}

interface WalletsResponse {
  success: boolean;
  data: {
    derivationPath: string;
    wallets: WalletEntry[];
  };
}

export default function WalletsPage() {
  const { data, error, isLoading } = useSWR<WalletsResponse>(
    `${apiBaseUrl}/api/wallets`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const wallets = data?.data?.wallets ?? [];
  const derivationPath = data?.data?.derivationPath ?? "m/44'/236'/0'/0/{index}";

  return (
    <main className="min-h-screen bg-deep-space p-6 text-slate-100">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-electric-cyan">
          Aircraft Wallets
        </h1>
        <p className="mb-1 text-sm text-slate-400">
          Every aircraft has a deterministic BSV wallet derived via BIP44.
          All on-chain telemetry transactions are publicly verifiable.
        </p>
        <p className="mb-6 font-mono text-xs text-slate-500">
          Derivation: <span className="text-slate-300">{derivationPath}</span>
        </p>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-electric-cyan border-t-transparent" />
            Loading wallets…
          </div>
        )}

        {error && (
          <p className="text-sm text-alert-red">
            Failed to load wallets: {(error as Error).message}
          </p>
        )}

        {!isLoading && wallets.length === 0 && !error && (
          <p className="text-sm text-slate-500">No wallets configured.</p>
        )}

        {wallets.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-slate-700/50 bg-slate-900/60">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-xs uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">ICAO</th>
                  <th className="px-4 py-3">Index</th>
                  <th className="px-4 py-3">BSV Address</th>
                  <th className="px-4 py-3 text-right">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => (
                  <tr
                    key={w.icao}
                    className="border-b border-slate-800/50 transition-colors hover:bg-slate-800/30"
                  >
                    <td className="px-4 py-2.5 font-mono font-semibold text-electric-cyan">
                      {w.icao}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">
                      {w.walletIndex}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                      {w.address}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <a
                        href={w.wocUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/20"
                      >
                        View on WoC
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs text-slate-500">
          {wallets.length} wallet{wallets.length !== 1 ? "s" : ""} configured
          · Chronicle tx.version = 2
        </p>
      </div>
    </main>
  );
}
