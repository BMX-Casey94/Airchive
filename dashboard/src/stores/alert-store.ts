import { create } from "zustand";
import type { AlertRecord, AlertSeverity } from "@/types/airchive";

interface EmergencyInfo {
  icao: string;
  callsign: string;
  squawk: string;
  description: string;
}

interface AlertState {
  /** Chronological alert log (newest last). */
  alerts: AlertRecord[];
  /** Whether an unacknowledged emergency is active. */
  emergencyActive: boolean;
  /** Details of the active emergency (null when inactive). */
  emergencyInfo: EmergencyInfo | null;

  /** Append a new alert to the log. */
  pushAlert: (alert: AlertRecord) => void;
  /** Bulk-replace alerts (e.g. on initial load). */
  setAlerts: (alerts: AlertRecord[]) => void;
  /** Mark an alert as acknowledged by ID. */
  acknowledgeAlert: (id: string) => void;
  /** Trigger the emergency overlay. */
  activateEmergency: (info: EmergencyInfo) => void;
  /** Dismiss the emergency overlay. */
  dismissEmergency: () => void;
}

const MAX_ALERTS = 500;

export const useAlertStore = create<AlertState>((set) => ({
  alerts: [],
  emergencyActive: false,
  emergencyInfo: null,

  pushAlert: (alert) =>
    set((prev) => {
      const next = [...prev.alerts, alert].slice(-MAX_ALERTS);
      return { alerts: next };
    }),

  setAlerts: (alerts) => set({ alerts: alerts.slice(-MAX_ALERTS) }),

  acknowledgeAlert: (id) =>
    set((prev) => ({
      alerts: prev.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a,
      ),
    })),

  activateEmergency: (info) =>
    set({ emergencyActive: true, emergencyInfo: info }),

  dismissEmergency: () =>
    set({ emergencyActive: false, emergencyInfo: null }),
}));
