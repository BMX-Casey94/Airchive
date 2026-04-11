"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import { useFleetStore } from "@/stores/fleet-store";
import { fmtSpeed } from "@/lib/format";

export default function SpeedChart() {
  const history = useFleetStore((s) => s.telemetryHistory);

  const now = Date.now();
  const data = history.map((p) => ({
    time: Math.round((p.ts - now) / 1000),
    gs: p.gs,
    ias: p.ias,
    tas: p.tas,
  }));

  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            tickFormatter={(v: number) => fmtSpeed(v)}
            axisLine={{ stroke: "#1B2D45" }}
            tickLine={{ stroke: "#1B2D45" }}
            width={48}
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
            formatter={(value: number, name: string) => [
              `${fmtSpeed(value)} kts`,
              name.toUpperCase(),
            ]}
          />

          <Legend
            wrapperStyle={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
            iconType="line"
            iconSize={10}
          />

          <Line
            type="monotone"
            dataKey="gs"
            name="GS"
            stroke="#00F5FF"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="ias"
            name="IAS"
            stroke="#00FF88"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="tas"
            name="TAS"
            stroke="#FFB800"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
