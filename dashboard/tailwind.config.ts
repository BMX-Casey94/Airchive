import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "space-black": "#060B14",
        "deep-navy": "#0A1628",
        "panel-bg": "#0D1B2A",
        "panel-border": "#1B2D45",
        "electric-cyan": "#00F5FF",
        "neon-amber": "#FFB800",
        "signal-green": "#00FF88",
        "alert-red": "#FF3B5C",
        "hud-muted": "#6F86A0",
        "muted-blue": "#2A4A6B",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "glow-cyan": "0 0 20px rgba(0, 245, 255, 0.1)",
        "glow-amber": "0 0 20px rgba(255, 184, 0, 0.1)",
        "glow-green": "0 0 20px rgba(0, 255, 136, 0.1)",
        "glow-red": "0 0 20px rgba(255, 59, 92, 0.15)",
      },
      animation: {
        "scan-line": "scanLine 4s linear infinite",
        "pulse-slow": "pulse 3s ease-in-out infinite",
      },
      keyframes: {
        scanLine: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
