// Placeholder — wired up properly in PR 3 (queue summary + items).

interface Props {
  workspace: string;
}

export function QueueTab({ workspace }: Props) {
  return (
    <section className="placeholder">
      <h2>Queue</h2>
      <p>
        Deriver / summary / dream tasks for <code>{workspace}</code>. Manual
        refresh, no polling. Implemented in PR 3.
      </p>
    </section>
  );
}
