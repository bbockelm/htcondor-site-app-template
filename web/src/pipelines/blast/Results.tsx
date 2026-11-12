// What a BLAST node job found.
//
// Read from results.json, which the runner writes on every path
// including every failure -- so there is always something to show, and
// a failed search explains itself rather than appearing as an empty
// table.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Job } from '../../lib/api';

interface Hit {
  query_file: string;
  query: string;
  subject: string;
  identity: number;
  length: number;
  evalue: string;
  bits: number;
}

interface BlastResult {
  status: string;
  message: string;
  program: string;
  database: string;
  evalue: string;
  total_hits: number;
  queries: { file: string; status: string; hits: number }[];
  top_hits: Hit[];
  top_hits_truncated: boolean;
}

export function Results({ job }: { job: Job }) {
  const id = `${job.ClusterId}.${job.ProcId}`;
  const [data, setData] = useState<BlastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .jobFile(id, 'results.json')
      .then((text) => {
        if (!live) return;
        setData(JSON.parse(text) as BlastResult);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="meta">Reading results…</p>;

  return (
    <div data-testid="blast-results">
      <p>
        {data.program} against {data.database}, E ≤ {data.evalue}: <strong>{data.total_hits}</strong>{' '}
        hits.
      </p>
      {/* The runner's own words. For a failure this is the whole
          explanation, so it is shown before the table rather than
          under it. */}
      {data.status !== 'ok' && <p className="error">{data.message}</p>}
      {data.top_hits.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Subject</th>
              <th>Identity</th>
              <th>Length</th>
              <th>E</th>
              <th>Bits</th>
            </tr>
          </thead>
          <tbody>
            {data.top_hits.map((h, i) => (
              <tr key={`${h.query}-${h.subject}-${i}`}>
                <td title={h.query_file}>{h.query}</td>
                <td>{h.subject}</td>
                <td>{h.identity.toFixed(1)}%</td>
                <td>{h.length}</td>
                <td>{h.evalue}</td>
                <td>{h.bits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.top_hits_truncated && (
        <p className="meta">
          Showing the strongest hits only. <a href={api.fileUrl(id, 'hits.tsv')}>Download all</a>.
        </p>
      )}
    </div>
  );
}
