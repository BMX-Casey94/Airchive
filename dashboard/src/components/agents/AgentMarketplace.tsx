"use client";

import { useAgentStore, type AgentInfo, type AgentEvent } from "@/stores/agent-store";
import Panel from "@/components/ui/Panel";
import clsx from "clsx";
import { fmtSats, fmtTime } from "@/lib/format";

/* ── Agent Status Card ─────────────────────────────────────────── */

function AgentCard({ agent }: { agent: AgentInfo & { id: string } }) {
  const statusColour: Record<AgentInfo["status"], string> = {
    offline: "bg-hud-muted/60",
    starting: "bg-neon-amber animate-pulse",
    running: "bg-signal-green",
    error: "bg-alert-red animate-pulse",
  };

  const roleIcon: Record<string, string> = {
    collector: "C",
    analyst: "A",
    monitor: "M",
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-panel-border/30 bg-panel-bg/20 backdrop-blur-lg p-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-electric-cyan/10 border border-electric-cyan/30 font-mono text-sm font-bold text-electric-cyan">
        {roleIcon[agent.id] ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-hud-text">
            {agent.name}
          </span>
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full flex-shrink-0",
              statusColour[agent.status],
            )}
          />
          <span className="text-[9px] font-mono text-hud-muted uppercase">
            {agent.status}
          </span>
        </div>
        <p className="text-[9px] font-mono text-hud-muted mt-0.5">
          {agent.role}
        </p>
        {agent.identityKey && (
          <p className="text-[8px] font-mono text-electric-cyan/60 mt-0.5 truncate">
            {agent.identityKey.slice(0, 20)}...
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Event Row ─────────────────────────────────────────────────── */

function EventRow({ event }: { event: AgentEvent }) {
  const typeStyles: Record<AgentEvent["type"], { colour: string; label: string }> = {
    discovery: { colour: "text-signal-green", label: "DISC" },
    transaction: { colour: "text-electric-cyan", label: "TX" },
    analysis: { colour: "text-neon-amber", label: "ANLS" },
    status: { colour: "text-hud-muted", label: "STAT" },
    message: { colour: "text-electric-cyan/70", label: "MSG" },
  };

  const style = typeStyles[event.type] ?? typeStyles.status;

  let detail = "";
  if (event.type === "transaction") {
    const amount = event.data.amountSats as number;
    const product = event.data.product as string;
    detail = `${amount} sat${amount !== 1 ? "s" : ""} — ${product}`;
  } else if (event.type === "discovery") {
    detail = event.data.message as string;
  } else if (event.type === "analysis") {
    const txid = event.data.txid as string;
    detail = txid !== "pending"
      ? `Published: ${txid.slice(0, 12)}...`
      : event.data.summary as string;
  } else if (event.type === "message") {
    detail = `→ ${event.data.to}: ${event.data.messageType}`;
  } else {
    detail = event.data.status as string ?? "";
  }

  return (
    <div className="flex items-center gap-2 py-1 border-b border-panel-border/10 last:border-0">
      <span className="text-[8px] font-mono text-hud-muted/60 flex-shrink-0 w-14 text-right tabular-nums">
        {fmtTime(event.timestamp)}
      </span>
      <span
        className={clsx(
          "text-[8px] font-mono font-bold flex-shrink-0 w-8 text-center",
          style.colour,
        )}
      >
        {style.label}
      </span>
      <span className="text-[8px] font-mono text-electric-cyan/80 flex-shrink-0 w-14 capitalize">
        {event.agent}
      </span>
      <span className="text-[9px] font-mono text-hud-text/80 truncate flex-1">
        {detail}
      </span>
    </div>
  );
}

/* ── Main Component ────────────────────────────────────────────── */

export function AgentMarketplace() {
  const agents = useAgentStore((s) => s.agents);
  const events = useAgentStore((s) => s.events);
  const totalPayments = useAgentStore((s) => s.totalPayments);
  const totalEarnedSats = useAgentStore((s) => s.totalEarnedSats);
  const totalSpentSats = useAgentStore((s) => s.totalSpentSats);

  const agentEntries = Object.entries(agents).map(([id, info]) => ({
    id,
    ...info,
  }));

  const recentEvents = events.slice(0, 50);

  return (
    <section className="lg:col-span-12 space-y-3">
      <Panel
        title="Agent Marketplace"
        headerAction={
          <div className="flex items-center gap-3">
            <span className="text-[9px] font-mono text-hud-muted/50 italic">
              (this session)
            </span>
            <span className="text-[9px] font-mono text-hud-muted">
              {totalPayments.toLocaleString("en-GB")} payments
            </span>
            <span className="text-[9px] font-mono text-signal-green">
              +{fmtSats(totalEarnedSats)}
            </span>
            <span className="text-[9px] font-mono text-neon-amber">
              -{fmtSats(totalSpentSats)}
            </span>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Agent Status Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {agentEntries.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>

          {/* Stats Row — session-scoped counters (reset on page reload) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile
              label="Payments (session)"
              value={totalPayments.toLocaleString("en-GB")}
              colour="text-electric-cyan"
            />
            <StatTile
              label="Earned (session)"
              value={fmtSats(totalEarnedSats)}
              colour="text-signal-green"
            />
            <StatTile
              label="Spent (session)"
              value={fmtSats(totalSpentSats)}
              colour="text-neon-amber"
            />
            <StatTile
              label="Discoveries (session)"
              value={events.filter((e) => e.type === "discovery").length.toString()}
              colour="text-signal-green"
            />
          </div>

          {/* Live Activity Feed */}
          <div>
            <h3 className="text-[9px] font-mono uppercase tracking-widest text-hud-muted mb-2">
              Live Activity Feed
            </h3>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-panel-border/20 bg-panel-bg/10 p-2 scrollbar-thin scrollbar-thumb-panel-border/30">
              {recentEvents.length === 0 ? (
                <p className="text-[9px] font-mono text-hud-muted/50 text-center py-4">
                  Awaiting agent activity&hellip;
                </p>
              ) : (
                recentEvents.map((event, i) => (
                  <EventRow key={`${event.timestamp}-${i}`} event={event} />
                ))
              )}
            </div>
          </div>
        </div>
      </Panel>
    </section>
  );
}

/* ── Stat Tile ─────────────────────────────────────────────────── */

function StatTile({
  label,
  value,
  colour = "text-electric-cyan",
}: {
  label: string;
  value: string;
  colour?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-panel-border/30 bg-panel-bg/20 backdrop-blur-lg px-3 py-2.5 text-center">
      <p className="hud-label text-[8px] mb-1">{label}</p>
      <p className={clsx("font-mono text-xs font-bold tabular-nums leading-none", colour)}>
        {value}
      </p>
    </div>
  );
}
