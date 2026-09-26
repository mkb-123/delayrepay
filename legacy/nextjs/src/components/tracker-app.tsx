"use client";

import { AlertCircle, Check, ChevronRight, Download, ExternalLink, Filter, RotateCcw, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Archive, StoredService } from "@/domain/archive";
import { emptyArchive } from "@/domain/archive";
import { acknowledge, undo, type LocalRecord, type LocalRecords } from "@/domain/claims";
import { rules } from "@/domain/rules";
import { londonDate, timeLabel, windows } from "@/domain/time";
import type { Assessment, BaseStatus, Direction, JourneyEvidence } from "@/domain/types";

const STORAGE_KEY = "mkc-eus-delay-repay-local-v1";
const BACKUP_VERSION = 1;

type EffectiveStoredService = StoredService & {
  effectiveAssessment: Assessment;
  claimedAt: string | null;
  local?: LocalRecord;
};

type Filters = {
  date: string;
  direction: "" | Direction;
  operator: string;
  status: "" | BaseStatus | "CLAIMED";
};

const emptyFilters: Filters = { date: "", direction: "", operator: "", status: "" };

export function TrackerApp() {
  const [archive, setArchive] = useState<Archive>(() => emptyArchive());
  const [local, setLocal] = useState<LocalRecords>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "history">("dashboard");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = readLocal();
    setLocal(saved.records);
    setSaveError(saved.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
        const response = await fetch(`${basePath}/data/archive.json`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = coerceArchive(await response.json());
        if (!cancelled) {
          setArchive(next);
          setLoadError(null);
        }
      } catch {
        if (!cancelled) setLoadError("Rail evidence has not been published yet, or the latest archive could not be read.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        const saved = readLocal();
        setLocal(saved.records);
        setSaveError(saved.error);
      }
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);

  const records = useMemo(() => mergeLocal(archive.services, local), [archive.services, local]);
  const outstanding = records.filter(record => record.effectiveAssessment.status === "POTENTIAL" && !record.claimedAt).length;
  const today = londonDate();
  const todayRecords = records.filter(record => record.service.serviceDate === today);
  const visibleRecords = useMemo(() => filterRecords(records, filters), [records, filters]);
  const selected = records.find(record => record.service.id === selectedId) ?? null;
  const operators = [...new Set(records.map(record => record.service.operatorName).filter(Boolean))].sort();

  const saveLocal = (next: LocalRecords) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: BACKUP_VERSION, records: next }));
      setLocal(next);
      setSaveError(null);
    } catch {
      setSaveError("Could not save claim acknowledgements in this browser.");
    }
  };

  const markClaimed = (record: EffectiveStoredService) => {
    try {
      saveLocal({ ...local, [record.service.id]: acknowledge({ ...record, assessment: record.effectiveAssessment }, local[record.service.id]) });
    } catch {
      setSaveError("Only potential claims can be marked as claimed.");
    }
  };

  const undoClaimed = (record: EffectiveStoredService) => {
    const previous = local[record.service.id];
    if (!previous) return;
    saveLocal({ ...local, [record.service.id]: undo(previous) });
  };

  const setEvidence = (record: EffectiveStoredService, evidence: JourneyEvidence) => {
    const previous = local[record.service.id];
    saveLocal({
      ...local,
      [record.service.id]: {
        ...previous,
        serviceId: record.service.id,
        evidence,
        claimedAt: previous?.claimedAt ?? null,
        updatedAt: new Date().toISOString(),
      },
    });
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ version: BACKUP_VERSION, records: local }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `delay-repay-claims-${today}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = async (file: File | undefined) => {
    if (!file || file.size > 1_000_000) {
      setSaveError("Choose a claim backup JSON file under 1 MB.");
      return;
    }
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));
      saveLocal(parsed);
    } catch {
      setSaveError("That file does not look like a valid claim backup.");
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  return (
    <main className="min-h-screen bg-[var(--paper)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-[var(--line)] pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-[var(--accent)]">MKC EUS Delay Repay Tracker</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--ink)]">Potential claims: {outstanding}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Weekday MKC to EUS 06:00-08:00 and EUS to MKC 16:30-18:00. Times are London time.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={tabClass(view === "dashboard")} onClick={() => setView("dashboard")}>Dashboard</button>
            <button className={tabClass(view === "history")} onClick={() => setView("history")}>History</button>
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium" onClick={exportBackup}>
              <Download size={16} /> Backup
            </button>
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium" onClick={() => importInput.current?.click()}>
              <Upload size={16} /> Import
            </button>
            <input ref={importInput} className="hidden" type="file" accept="application/json" onChange={event => importBackup(event.target.files?.[0])} />
          </div>
        </header>

        {(loadError || saveError || archive.runs.at(-1)?.status === "PARTIAL" || archive.runs.at(-1)?.status === "FAILED") && (
          <StatusBanner loadError={loadError} saveError={saveError} archive={archive} />
        )}

        {view === "dashboard" ? (
          <Dashboard records={todayRecords.length ? todayRecords : records.slice(0, 24)} loading={loading} onSelect={setSelectedId} onClaim={markClaimed} onUndo={undoClaimed} />
        ) : (
          <History records={visibleRecords} filters={filters} operators={operators} setFilters={setFilters} onSelect={setSelectedId} onClaim={markClaimed} onUndo={undoClaimed} />
        )}
      </div>

      {selected && (
        <DetailPanel record={selected} allRecords={records} onClose={() => setSelectedId(null)} onClaim={markClaimed} onUndo={undoClaimed} onEvidence={setEvidence} />
      )}
    </main>
  );
}

function Dashboard({ records, loading, onSelect, onClaim, onUndo }: {
  records: EffectiveStoredService[];
  loading: boolean;
  onSelect: (id: string) => void;
  onClaim: (record: EffectiveStoredService) => void;
  onUndo: (record: EffectiveStoredService) => void;
}) {
  const grouped = groupByDate(records);
  if (!records.length) {
    return (
      <section className="rounded-md border border-dashed border-[var(--line)] bg-white p-5">
        <p className="font-medium">{loading ? "Loading rail evidence..." : "No monitored services are stored yet."}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">Once the GitHub Action has RTT credentials and runs, services will appear here from the retained archive.</p>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {grouped.map(group => (
        <section key={group.date} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{dayLabel(group.date)}</h2>
          <DirectionGroup title="Morning - MKC to EUS" direction="MORNING" records={group.records} onSelect={onSelect} onClaim={onClaim} onUndo={onUndo} />
          <DirectionGroup title="Evening - EUS to MKC" direction="EVENING" records={group.records} onSelect={onSelect} onClaim={onClaim} onUndo={onUndo} />
        </section>
      ))}
    </div>
  );
}

function History({ records, filters, operators, setFilters, onSelect, onClaim, onUndo }: {
  records: EffectiveStoredService[];
  filters: Filters;
  operators: string[];
  setFilters: (filters: Filters) => void;
  onSelect: (id: string) => void;
  onClaim: (record: EffectiveStoredService) => void;
  onUndo: (record: EffectiveStoredService) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-md border border-[var(--line)] bg-white p-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm font-medium">
          Date
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" type="date" value={filters.date} onChange={event => setFilters({ ...filters, date: event.target.value })} />
        </label>
        <label className="text-sm font-medium">
          Direction
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={filters.direction} onChange={event => setFilters({ ...filters, direction: event.target.value as Filters["direction"] })}>
            <option value="">All</option>
            <option value="MORNING">MKC to EUS</option>
            <option value="EVENING">EUS to MKC</option>
          </select>
        </label>
        <label className="text-sm font-medium">
          Operator
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={filters.operator} onChange={event => setFilters({ ...filters, operator: event.target.value })}>
            <option value="">All</option>
            {operators.map(operator => <option key={operator} value={operator}>{operator}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">
          Status
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value as Filters["status"] })}>
            <option value="">All</option>
            <option value="POTENTIAL">Potential claim</option>
            <option value="CLAIMED">Claimed</option>
            <option value="NEEDS_REVIEW">Needs review</option>
            <option value="NO_CLAIM">No claim</option>
          </select>
        </label>
        <button className="focus-ring mt-auto inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[var(--ink)] px-3 text-sm font-medium text-white" onClick={() => setFilters(emptyFilters)}>
          <Filter size={16} /> Clear
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {records.length ? records.map(record => <ServiceCard key={record.service.id} record={record} onSelect={onSelect} onClaim={onClaim} onUndo={onUndo} />) : (
          <div className="rounded-md border border-dashed border-[var(--line)] bg-white p-5 text-sm text-[var(--muted)]">
            <Search className="mb-2" size={18} /> No stored services match these filters.
          </div>
        )}
      </div>
    </section>
  );
}

function DirectionGroup(props: {
  title: string;
  direction: Direction;
  records: EffectiveStoredService[];
  onSelect: (id: string) => void;
  onClaim: (record: EffectiveStoredService) => void;
  onUndo: (record: EffectiveStoredService) => void;
}) {
  const items = props.records.filter(record => record.service.direction === props.direction);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">{props.title}</h3>
      {items.length ? items.map(record => <ServiceCard key={record.service.id} record={record} onSelect={props.onSelect} onClaim={props.onClaim} onUndo={props.onUndo} />) : (
        <p className="rounded-md border border-[var(--line)] bg-white p-3 text-sm text-[var(--muted)]">No services stored for this window.</p>
      )}
    </div>
  );
}

function ServiceCard({ record, onSelect, onClaim, onUndo }: {
  record: EffectiveStoredService;
  onSelect: (id: string) => void;
  onClaim: (record: EffectiveStoredService) => void;
  onUndo: (record: EffectiveStoredService) => void;
}) {
  const s = record.service;
  const a = record.effectiveAssessment;
  const claimUrl = rules[s.operatorCode]?.claimUrl;
  return (
    <article className="rounded-md border border-[var(--line)] bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-lg font-semibold">{timeLabel(s.scheduledDeparture)}</span>
            <span className="text-sm text-[var(--muted)]">{s.operatorName}</span>
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Scheduled arrival: {timeLabel(s.scheduledArrival)} · Actual arrival: {timeLabel(s.actualArrival)} · {delayLabel(a.rawDelayMinutes)}
          </p>
        </div>
        <StatusPill status={a.status} claimed={!!record.claimedAt} />
      </div>
      <p className="mt-3 text-sm">{a.explanation}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" onClick={() => onSelect(s.id)}>
          View details <ChevronRight size={16} />
        </button>
        {record.claimedAt ? (
          <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" onClick={() => onUndo(record)}>
            <RotateCcw size={16} /> Undo
          </button>
        ) : (
          <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white" disabled={a.status !== "POTENTIAL"} onClick={() => onClaim(record)}>
            <Check size={16} /> Mark as claimed
          </button>
        )}
        {claimUrl && a.status === "POTENTIAL" && (
          <a className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" href={claimUrl} target="_blank" rel="noreferrer">
            Claim with {shortOperator(s.operatorName)} <ExternalLink size={16} />
          </a>
        )}
      </div>
    </article>
  );
}

function DetailPanel({ record, allRecords, onClose, onClaim, onUndo, onEvidence }: {
  record: EffectiveStoredService;
  allRecords: EffectiveStoredService[];
  onClose: () => void;
  onClaim: (record: EffectiveStoredService) => void;
  onUndo: (record: EffectiveStoredService) => void;
  onEvidence: (record: EffectiveStoredService, evidence: JourneyEvidence) => void;
}) {
  const s = record.service;
  const a = record.effectiveAssessment;
  const rule = rules[s.operatorCode];
  const related = allRecords.filter(item => item.service.serviceDate === s.serviceDate && item.service.direction === s.direction && item.service.id !== s.id);
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/35 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="max-h-[92vh] w-full overflow-auto rounded-t-md bg-white p-4 shadow-xl sm:mx-auto sm:max-w-3xl sm:rounded-md">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] pb-3">
          <div>
            <p className="text-sm font-semibold text-[var(--accent)]">{s.origin} to {s.destination} · {s.serviceDate}</p>
            <h2 className="mt-1 text-xl font-semibold">{timeLabel(s.scheduledDeparture)} · {s.operatorName}</h2>
          </div>
          <button className="focus-ring h-10 rounded-md border border-[var(--line)] px-3 text-sm font-medium" onClick={onClose}>Close</button>
        </div>

        <div className="grid gap-4 py-4 md:grid-cols-2">
          <InfoList title="Service Evidence" rows={[
            ["RTT service", s.rttServiceId],
            ["Scheduled departure", timeLabel(s.scheduledDeparture)],
            ["Actual departure", timeLabel(s.actualDeparture)],
            ["Scheduled arrival", timeLabel(s.scheduledArrival)],
            ["Actual arrival", timeLabel(s.actualArrival)],
            ["Cancellation", s.cancelled ? "Cancelled" : "No cancellation recorded"],
            ["Raw destination delay", delayLabel(a.rawDelayMinutes)],
            ["Collected", formatDateTime(s.lastCollectedAt)],
          ]} />
          <InfoList title="Assessment" rows={[
            ["Status", record.claimedAt ? "Claimed" : readableStatus(a.status)],
            ["Effective journey delay", delayLabel(a.effectiveDelayMinutes)],
            ["Rule", a.ruleVersion],
            ["Minimum delay", a.minimumDelay === null ? "Unknown" : `${a.minimumDelay} minutes`],
            ["Verified", a.ruleVerifiedAt ?? "Not verified"],
            ["Collection complete", a.collectionComplete ? "Yes" : "No"],
          ]} />
        </div>

        <section className="border-t border-[var(--line)] py-4">
          <h3 className="font-semibold">Reason</h3>
          <p className="mt-2 text-sm">{a.explanation}</p>
          {a.steps.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">{a.steps.map(step => <li key={step}>{step}</li>)}</ul>}
          {a.assumptions.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">{a.assumptions.map(step => <li key={step}>{step}</li>)}</ul>}
        </section>

        <EvidenceEditor record={record} related={related} onEvidence={onEvidence} />

        <section className="border-t border-[var(--line)] py-4">
          <h3 className="font-semibold">Alternative Services Considered</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <thead className="border-b border-[var(--line)] text-[var(--muted)]">
                <tr><th className="py-2 pr-3">Departure</th><th className="py-2 pr-3">Operator</th><th className="py-2 pr-3">Actual arrival</th><th className="py-2 pr-3">Scenario delay</th><th className="py-2 pr-3">Use</th></tr>
              </thead>
              <tbody>
                {a.alternatives.length ? a.alternatives.map(alt => (
                  <tr key={alt.serviceId} className="border-b border-[var(--line)]">
                    <td className="py-2 pr-3">{timeLabel(alt.scheduledDeparture)}</td>
                    <td className="py-2 pr-3">{alt.operatorName}</td>
                    <td className="py-2 pr-3">{timeLabel(alt.actualArrival)}</td>
                    <td className="py-2 pr-3">{delayLabel(alt.estimatedJourneyDelay)}</td>
                    <td className="py-2 pr-3">{alt.applicability}: {alt.reason}</td>
                  </tr>
                )) : <tr><td className="py-3 text-[var(--muted)]" colSpan={5}>No applicable direct alternative was found in the collected window.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="border-t border-[var(--line)] py-4">
          <h3 className="font-semibold">Rule Source</h3>
          <p className="mt-2 text-sm text-[var(--muted)]">{rule?.summary ?? "No verified rule is configured for this operator."}</p>
          {a.ruleSource && <a className="focus-ring mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" href={a.ruleSource} target="_blank" rel="noreferrer">Official terms <ExternalLink size={16} /></a>}
        </section>

        <div className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-4">
          {record.claimedAt ? (
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" onClick={() => onUndo(record)}><RotateCcw size={16} /> Undo claimed</button>
          ) : (
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white" disabled={a.status !== "POTENTIAL"} onClick={() => onClaim(record)}><Check size={16} /> Mark as claimed</button>
          )}
          {rule?.claimUrl && <a className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] px-3 text-sm font-medium" href={rule.claimUrl} target="_blank" rel="noreferrer">Claim with {shortOperator(s.operatorName)} <ExternalLink size={16} /></a>}
        </div>
      </div>
    </div>
  );
}

function EvidenceEditor({ record, related, onEvidence }: {
  record: EffectiveStoredService;
  related: EffectiveStoredService[];
  onEvidence: (record: EffectiveStoredService, evidence: JourneyEvidence) => void;
}) {
  const evidence = record.local?.evidence ?? record.effectiveAssessment.evidence;
  const update = (patch: Partial<JourneyEvidence>) => onEvidence(record, { ...evidence, ...patch });
  return (
    <section className="border-t border-[var(--line)] py-4">
      <h3 className="font-semibold">Your Journey Confirmation</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">Journey taken
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={evidence.travelled} onChange={event => update({ travelled: event.target.value as JourneyEvidence["travelled"], alternativeId: undefined })}>
            <option value="UNKNOWN">Unknown</option>
            <option value="ORIGINAL">Original service</option>
            <option value="ALTERNATIVE">Alternative service</option>
            <option value="NOT_TRAVELLED">Did not travel</option>
          </select>
        </label>
        <label className="text-sm font-medium">Ticket profile
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={evidence.ticketScope} onChange={event => update({ ticketScope: event.target.value as JourneyEvidence["ticketScope"] })}>
            <option value="ANY_PERMITTED">Any permitted operator</option>
            <option value="SAME_OPERATOR">Operator restricted</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-4 w-4" checked={evidence.ticketValid} onChange={event => update({ ticketValid: event.target.checked })} />
          Valid ticket held for the journey taken
        </label>
        {evidence.travelled === "ALTERNATIVE" && (
          <label className="text-sm font-medium">Alternative used
            <select className="focus-ring mt-1 h-10 w-full rounded-md border border-[var(--line)] px-3" value={evidence.alternativeId ?? ""} onChange={event => update({ alternativeId: event.target.value || undefined })}>
              <option value="">Select service</option>
              {related.map(item => <option key={item.service.id} value={item.service.id}>{timeLabel(item.service.scheduledDeparture)} {item.service.operatorName}</option>)}
            </select>
          </label>
        )}
      </div>
    </section>
  );
}

function InfoList({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section>
      <h3 className="font-semibold">{title}</h3>
      <dl className="mt-3 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
        {rows.map(([key, value]) => (
          <div className="grid grid-cols-[42%_1fr] gap-3 px-3 py-2 text-sm" key={key}>
            <dt className="text-[var(--muted)]">{key}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StatusBanner({ loadError, saveError, archive }: { loadError: string | null; saveError: string | null; archive: Archive }) {
  const latest = archive.runs.at(-1);
  const text = saveError ?? loadError ?? (latest ? `Latest collection was ${latest.status.toLowerCase()}: ${latest.message}` : null);
  if (!text) return null;
  return (
    <div className="flex gap-3 rounded-md border border-amber-300 bg-[var(--warn-bg)] p-3 text-sm text-amber-950">
      <AlertCircle size={18} className="mt-0.5 flex-none" />
      <div>
        <p className="font-semibold">{text}</p>
        <p className="mt-1">Last successful collection: {archive.lastSuccessfulAt ? formatDateTime(archive.lastSuccessfulAt) : "none recorded"}.</p>
      </div>
    </div>
  );
}

function StatusPill({ status, claimed }: { status: BaseStatus; claimed: boolean }) {
  const label = claimed ? "Claimed" : readableStatus(status);
  const cls = claimed || status === "NO_CLAIM"
    ? "bg-[var(--good-bg)] text-[var(--good)]"
    : status === "POTENTIAL"
      ? "bg-[var(--warn-bg)] text-[var(--warn)]"
      : "bg-[var(--review-bg)] text-[var(--review)]";
  return <span className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}

function mergeLocal(records: StoredService[], local: LocalRecords): EffectiveStoredService[] {
  const live = records.map(record => {
    const saved = local[record.service.id];
    const assessment = saved?.restoredAssessment ?? record.assessment;
    return { ...record, effectiveAssessment: assessment, claimedAt: saved?.claimedAt ?? null, local: saved };
  });
  const liveIds = new Set(live.map(record => record.service.id));
  const snapshots = Object.values(local)
    .filter(item => item.claimedSnapshot && !liveIds.has(item.serviceId))
    .map(item => ({
      ...item.claimedSnapshot!,
      effectiveAssessment: item.restoredAssessment ?? item.claimedSnapshot!.assessment,
      claimedAt: item.claimedAt,
      local: item,
    }));
  return [...live, ...snapshots].sort((a, b) =>
    b.service.serviceDate.localeCompare(a.service.serviceDate) ||
    (a.service.scheduledDeparture ?? "").localeCompare(b.service.scheduledDeparture ?? "")
  );
}

function groupByDate(records: EffectiveStoredService[]) {
  const byDate = new Map<string, EffectiveStoredService[]>();
  for (const record of records) {
    const current = byDate.get(record.service.serviceDate) ?? [];
    current.push(record);
    byDate.set(record.service.serviceDate, current);
  }
  return [...byDate.entries()].map(([date, groupRecords]) => ({ date, records: groupRecords }));
}

function filterRecords(records: EffectiveStoredService[], filters: Filters) {
  return records.filter(record =>
    (!filters.date || record.service.serviceDate === filters.date) &&
    (!filters.direction || record.service.direction === filters.direction) &&
    (!filters.operator || record.service.operatorName === filters.operator) &&
    (!filters.status || (filters.status === "CLAIMED" ? !!record.claimedAt : record.effectiveAssessment.status === filters.status))
  );
}

function readLocal(): { records: LocalRecords; error: string | null } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return { records: raw ? parseBackup(JSON.parse(raw)) : {}, error: null };
  } catch {
    return { records: {}, error: "Claim acknowledgements could not be read from this browser." };
  }
}

function parseBackup(value: unknown): LocalRecords {
  if (!value || typeof value !== "object") throw new Error("bad backup");
  const candidate = value as { version?: unknown; records?: unknown };
  if (candidate.version !== BACKUP_VERSION || !candidate.records || typeof candidate.records !== "object" || Array.isArray(candidate.records)) throw new Error("bad backup");
  const clean: LocalRecords = {};
  for (const [key, item] of Object.entries(candidate.records as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as LocalRecord;
    if (typeof record.serviceId !== "string" || record.serviceId !== key) continue;
    clean[key] = {
      serviceId: key,
      evidence: validEvidence(record.evidence) ? record.evidence : undefined,
      claimedAt: typeof record.claimedAt === "string" || record.claimedAt === null ? record.claimedAt : null,
      claimedSnapshot: record.claimedSnapshot,
      restoredAssessment: record.restoredAssessment,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    };
  }
  return clean;
}

function validEvidence(value: unknown): value is JourneyEvidence {
  if (!value || typeof value !== "object") return false;
  const v = value as JourneyEvidence;
  return ["UNKNOWN", "ORIGINAL", "ALTERNATIVE", "NOT_TRAVELLED"].includes(v.travelled) &&
    ["ANY_PERMITTED", "SAME_OPERATOR", "UNKNOWN"].includes(v.ticketScope) &&
    typeof v.ticketValid === "boolean";
}

function coerceArchive(value: unknown): Archive {
  const maybe = value as Partial<Archive>;
  if (!maybe || maybe.schemaVersion !== 1 || !Array.isArray(maybe.services)) return emptyArchive();
  return {
    schemaVersion: 1,
    lastAttemptAt: maybe.lastAttemptAt ?? null,
    lastSuccessfulAt: maybe.lastSuccessfulAt ?? null,
    services: maybe.services,
    runs: Array.isArray(maybe.runs) ? maybe.runs : [],
  };
}

function readableStatus(status: BaseStatus) {
  return status === "POTENTIAL" ? "Potential claim" : status === "NEEDS_REVIEW" ? "Needs review" : "No claim";
}

function dayLabel(date: string) {
  const today = londonDate();
  return date === today ? "Today" : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}

function delayLabel(value: number | null) {
  if (value === null) return "Not established";
  if (value <= 0) return "On time";
  return `+${value} min`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value));
}

function shortOperator(operator: string) {
  return operator.includes("Northwestern") ? "LNR" : operator.includes("Avanti") ? "Avanti" : operator;
}

function tabClass(active: boolean) {
  return `focus-ring h-10 rounded-md px-3 text-sm font-medium ${active ? "bg-[var(--ink)] text-white" : "border border-[var(--line)] bg-white"}`;
}
