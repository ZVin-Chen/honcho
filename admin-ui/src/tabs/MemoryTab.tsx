import { useEffect, useState } from "react";
import {
  api,
  type ObservationsResponse,
  type PeerCard,
  type Peer,
  type Session,
} from "../api";
import { ObservationList } from "../components/ObservationList";

interface Props {
  workspace: string;
}

export function MemoryTab({ workspace }: Props) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [observer, setObserver] = useState("");
  const [target, setTarget] = useState("");
  const [session, setSession] = useState("");

  const [observations, setObservations] =
    useState<ObservationsResponse | null>(null);
  const [targetCard, setTargetCard] = useState<PeerCard | null>(null);
  const [selfCard, setSelfCard] = useState<PeerCard | null>(null);

  const [error, setError] = useState<string | null>(null);

  // Hydrate peer/session dropdowns whenever workspace changes.
  useEffect(() => {
    setPeers([]);
    setSessions([]);
    setObserver("");
    setTarget("");
    setSession("");
    setObservations(null);
    setTargetCard(null);
    setSelfCard(null);
    setError(null);

    api
      .listPeers(workspace)
      .then((r) => setPeers(r.items))
      .catch((e) => setError(String(e)));
    api
      .listSessions(workspace)
      .then((r) => setSessions(r.items))
      .catch((e) => setError(String(e)));
  }, [workspace]);

  async function load() {
    if (!observer) {
      setObservations(null);
      setTargetCard(null);
      setSelfCard(null);
      return;
    }
    setError(null);
    try {
      const observedName = target || observer;
      const [obs, tCard, sCard] = await Promise.all([
        api.listObservations(workspace, observer, {
          target: observedName,
          session: session || undefined,
          limit: 100,
        }),
        api.getPeerCard(workspace, observer, observedName),
        // Self-card is only meaningful when observer != target.
        observedName === observer
          ? Promise.resolve(null)
          : api.getPeerCard(workspace, observer, observer),
      ]);
      setObservations(obs);
      setTargetCard(tCard);
      setSelfCard(sCard);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (observer) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observer, target, session, workspace]);

  return (
    <section className="memory">
      <div className="form">
        <div className="form-row">
          <label>
            observer
            <select value={observer} onChange={(e) => setObserver(e.target.value)}>
              <option value="">— pick —</option>
              {peers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            target (observed)
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">self (observer)</option>
              {peers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            session
            <select value={session} onChange={(e) => setSession(e.target.value)}>
              <option value="">all sessions (global)</option>
              {sessions.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!observer && (
        <p className="muted">Pick an observer peer to inspect.</p>
      )}

      {observer && observations && (
        <div className="memory-grid">
          <aside className="memory-cards">
            <PeerCardPane
              title={
                targetCard && targetCard.observer !== targetCard.observed
                  ? `${targetCard.observer} → ${targetCard.observed}`
                  : "self-card"
              }
              card={targetCard}
            />
            {selfCard && (
              <PeerCardPane
                title={`${selfCard.observer} → self`}
                card={selfCard}
              />
            )}
          </aside>
          <div className="memory-observations">
            <h3 className="trace-section-title">
              Observations{" "}
              <span className="muted">
                — {observations.observations.explicit.length} explicit ·{" "}
                {observations.observations.deductive.length} deductive ·{" "}
                {observations.observations.inductive.length} inductive ·{" "}
                {observations.observations.contradiction.length} contradiction
                {observations.session && ` · session=${observations.session}`}
              </span>
            </h3>
            <ObservationList data={observations.observations} />
          </div>
        </div>
      )}
    </section>
  );
}

function PeerCardPane({
  title,
  card,
}: {
  title: string;
  card: PeerCard | null;
}) {
  return (
    <div className="peer-card">
      <h4>{title}</h4>
      {!card || card.bullets.length === 0 ? (
        <p className="muted">
          empty — deriver hasn't accumulated anything yet
        </p>
      ) : (
        <ul>
          {card.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
