import { type ReactNode } from "react";
import type {
  ContradictionObs,
  DeductiveObs,
  ExplicitObs,
  InductiveObs,
} from "../api";

export interface ObservationBuckets {
  explicit: ExplicitObs[];
  deductive: DeductiveObs[];
  inductive: InductiveObs[];
  contradiction: ContradictionObs[];
}

export function ObservationList({ data }: { data: ObservationBuckets }) {
  const sections: { label: string; items: ReactNode[] }[] = [
    {
      label: "explicit",
      items: data.explicit.map((o) => (
        <ObsRow key={o.id} obs={o} primary={o.content} />
      )),
    },
    {
      label: "deductive",
      items: data.deductive.map((o) => (
        <ObsRow
          key={o.id}
          obs={o}
          primary={o.conclusion}
          secondary={o.premises.join(" · ")}
        />
      )),
    },
    {
      label: "inductive",
      items: data.inductive.map((o) => (
        <ObsRow
          key={o.id}
          obs={o}
          primary={o.conclusion}
          secondary={`${o.pattern_type} · ${o.confidence}`}
        />
      )),
    },
    {
      label: "contradiction",
      items: data.contradiction.map((o) => (
        <ObsRow
          key={o.id}
          obs={o}
          primary={o.content}
          secondary={o.sources.join(" / ")}
        />
      )),
    },
  ];
  const present = sections.filter((s) => s.items.length > 0);
  if (present.length === 0) {
    return <p className="muted">No observations.</p>;
  }
  return (
    <div className="prefetch">
      {present.map((s) => (
        <details key={s.label} open>
          <summary>
            {s.label} <span className="muted">({s.items.length})</span>
          </summary>
          <div className="obs-list">{s.items}</div>
        </details>
      ))}
    </div>
  );
}

function ObsRow({
  obs,
  primary,
  secondary,
}: {
  obs: { id: string; created_at: string; session_name: string | null };
  primary: string;
  secondary?: string;
}) {
  return (
    <div className="obs-row">
      <div className="obs-meta">
        <span className="obs-time">
          {obs.created_at.replace("T", " ").slice(0, 19)}
        </span>
        {obs.session_name && (
          <span className="obs-session">{obs.session_name}</span>
        )}
      </div>
      <div className="obs-content">{primary}</div>
      {secondary && <div className="obs-secondary muted">{secondary}</div>}
    </div>
  );
}
