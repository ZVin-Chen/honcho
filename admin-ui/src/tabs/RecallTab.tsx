// Placeholder — wired up properly in PR 4 (dialectic trace).

interface Props {
  workspace: string;
}

export function RecallTab({ workspace }: Props) {
  return (
    <section className="placeholder">
      <h2>Recall</h2>
      <p>
        Submit a query and inspect the dialectic trace (prefetch → tool calls →
        answer) for <code>{workspace}</code>. Implemented in PR 4.
      </p>
    </section>
  );
}
