import type { Standing as StandingRow } from "@buzz/shared";

export function Standing({ rows }: { rows: StandingRow[] }) {
  if (rows.length === 0) return <p className="muted">No players yet.</p>;

  return (
    <ol className="standings">
      {rows.map((row) => (
        <li key={row.playerId}>
          <span className="rank">{row.rank}</span>
          <span className="name">{row.name}</span>
          <span className={`score ${row.score < 0 ? "negative" : ""}`}>{row.score}</span>
        </li>
      ))}
    </ol>
  );
}
