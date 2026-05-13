// Placeholder — wired up properly in PR 2 (observations + cards).

interface Props {
  workspace: string;
}

export function MemoryTab({ workspace }: Props) {
  return (
    <section className="placeholder">
      <h2>Memory</h2>
      <p>
        Observations and peer cards for <code>{workspace}</code> will live here.
        Implemented in PR 2.
      </p>
    </section>
  );
}
