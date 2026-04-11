"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { useFleetStore } from "@/stores/fleet-store";
import { fmtAltitude } from "@/lib/format";

export default function AltitudeChart() {
  const history = useFleetStore((s) => s.telemetryHistory);

  const now = Date.now();
  const data = history.map((p) => ({
    time: Math.round((p.ts - now) / 1000),
    alt: p.alt_baro,
  }));

  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="altGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00F5FF" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#00F5FF" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#2A4A6B"
            strokeOpacity={0.3}
            vertical={false}
          />

          <XAxis
            dataKey="time"
            tick={{ fill: "#2A4A6B", fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: number) => `${v}s`}
            axisLine={{ stroke: "#1B2D45" }}
            tickLine={{ stroke: "#1B2D45" }}
          />

          <YAxis
            tick={{ fill: "#2A4A6B", fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: number) => fmtAltitude(v)}
            axisLine={{ stroke: "#1B2D45" }}
            tickLine={{ stroke: "#1B2D45" }}
            width={56}
          />

          <Tooltip
            contentStyle={{
              backgroundColor: "#0D1B2A",
              border: "1px solid #1B2D45",
              borderRadius: 8,
              fontSize: 11,
              fontFamily: "JetBrains Mono",
            }}
            labelFormatter={(v: number) => `T${v}s`}
            formatter={(value: number) => [`${fmtAltitude(value)} ft`, "Altitude"]}
          />

          <Area
            type="monotone"
            dataKey="alt"
            stroke="#00F5FF"
            strokeWidth={1.5}
            fill="url(#altGradient)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
