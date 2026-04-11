import { create } from "zustand";

export interface AgentEvent {
  type: "discovery" | "transaction" | "analysis" | "status" | "message";
  agent: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface AgentInfo {
  name: string;
  role: string;
  identityKey: string;
  status: "offline" | "starting" | "running" | "error";
  balance?: number;
}

interface AgentStore {
  agents: Record<string, AgentInfo>;
  events: AgentEvent[];
  totalPayments: number;
  totalEarnedSats: number;
  totalSpentSats: number;

  pushEvent: (event: AgentEvent) => void;
  updateAgentStatus: (agent: string, status: AgentInfo["status"], balance?: number) => void;
  setAgentIdentity: (agent: string, identityKey: string) => void;
}

const MAX_EVENTS = 200;

const DEFAULT_AGENTS: Record<string, AgentInfo> = {
  collector: {
    name: "Collector",
    role: "Data Producer",
    identityKey: "",
    status: "offline",
  },
  analyst: {
    name: "Analyst",
    role: "Data Consumer & Analyser",
    identityKey: "",
    status: "offline",
  },
  monitor: {
    name: "Monitor",
    role: "Per-Aircraft Subscriber",
    identityKey: "",
    status: "offline",
  },
};

export const useAgentStore = create<AgentStore>((set) => ({
  agents: { ...DEFAULT_AGENTS },
  events: [],
  totalPayments: 0,
  totalEarnedSats: 0,
  totalSpentSats: 0,

  pushEvent: (event) =>
    set((state) => {
      const events = [event, ...state.events].slice(0, MAX_EVENTS);
      let { totalPayments, totalEarnedSats, totalSpentSats } = state;
      const agents = { ...state.agents };

      // Any event from a known agent proves it is alive — promote from offline
      const sender = agents[event.agent];
      if (sender && sender.status === "offline") {
        agents[event.agent] = { ...sender, status: "running" };
      }

      if (event.type === "transaction") {
        totalPayments++;
        const amount = (event.data.amountSats as number) ?? 0;
        if (event.agent === "collector") {
          totalEarnedSats += amount;
        } else {
          totalSpentSats += amount;
        }
      }

      if (event.type === "discovery" && event.data.identityKey) {
        const existing = agents[event.agent];
        if (existing) {
          agents[event.agent] = {
            ...existing,
            identityKey: event.data.identityKey as string,
          };
        }
      }

      if (event.type === "status") {
        const existing = agents[event.agent];
        if (existing) {
          agents[event.agent] = {
            ...existing,
            status: (event.data.status as AgentInfo["status"]) ?? existing.status,
            balance: (event.data.balance as number) ?? existing.balance,
          };
        }
      }

      return { events, totalPayments, totalEarnedSats, totalSpentSats, agents };
    }),

  updateAgentStatus: (agent, status, balance) =>
    set((state) => {
      const existing = state.agents[agent];
      if (!existing) return state;
      return {
        agents: {
          ...state.agents,
          [agent]: { ...existing, status, balance: balance ?? existing.balance },
        },
      };
    }),

  setAgentIdentity: (agent, identityKey) =>
    set((state) => {
      const existing = state.agents[agent];
      if (!existing) return state;
      return {
        agents: {
          ...state.agents,
          [agent]: { ...existing, identityKey },
        },
      };
    }),
}));
