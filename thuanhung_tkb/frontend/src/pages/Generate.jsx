import { useState } from 'react';
import { previewScheduling, commitScheduling } from '../services/scheduling.js';

const PRESETS = [
  { id: 'A_PREFERENCE_FIRST', label: 'A · Ưu tiên nguyện vọng' },
  { id: 'B_WORKLOAD_TRAVEL', label: 'B · Cân bằng workload + travel' },
  { id: 'C_BALANCED', label: 'C · Cân bằng tổng thể' },
];

export default function GeneratePage() {
  const [priority, setPriority] = useState('A_PREFERENCE_FIRST');
  const [solutionCount, setSolutionCount] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);

  async function onGenerate() {
    setLoading(true);
    setError(null);
    try {
      const data = await previewScheduling({
        solutions: solutionCount,
        strategies: [priority],
      });
      setResponse(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function onCommit(solutionId) {
    const result = await commitScheduling(solutionId);
    if (!result.ok) {
      setError(result.error);
    } else {
      alert(`solution ${solutionId} accepted (DB writer not implemented in this phase)`);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px' }}>
      <h1 style={{ marginTop: 0 }}>AI Generate</h1>
      <p style={{ color: 'var(--text-dim, #888)' }}>
        Mục tiêu của bạn. Hệ thống chạy AI Strategy, Optimization, Validator,
        và Diversity. Preview KHÔNG ghi database.
      </p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr', marginBottom: 24 }}>
        <label>
          <div>Ưu tiên</div>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: '100%', padding: 8 }}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label>
          <div>Số solution</div>
          <select value={solutionCount} onChange={(e) => setSolutionCount(Number(e.target.value))} style={{ width: '100%', padding: 8 }}>
            {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <button onClick={onGenerate} disabled={loading} style={{ padding: '10px 20px', fontSize: 16 }}>
        {loading ? 'Đang chạy...' : 'Generate'}
      </button>

      {error && <div style={{ marginTop: 16, color: 'crimson' }}>{error}</div>}

      {response && (
        <div style={{ marginTop: 24 }}>
          <h2>Situation</h2>
          <pre style={{ background: 'rgba(255,255,255,0.04)', padding: 12, overflow: 'auto' }}>
            {JSON.stringify(response.situation, null, 2)}
          </pre>

          <h2>Missing data</h2>
          {response.missingData.length === 0 ? (
            <p>(none)</p>
          ) : (
            <ul>{response.missingData.map((m, i) => <li key={i}>{m.entity}/{m.entityId}/{m.field}: {m.reason}</li>)}</ul>
          )}

          <h2>Warnings</h2>
          {response.warnings.length === 0 ? <p>(none)</p> : (
            <ul>{response.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}

          <h2>Solutions</h2>
          {response.solutions.length === 0 ? (
            <p>Không có solution khả thi. Hệ thống báo cáo <code>INFEASIBLE_DEMAND</code> hoặc <code>NO_SOLUTION</code>.</p>
          ) : (
            response.solutions.map((s) => (
              <div key={s.id} style={{ border: '1px solid #333', padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{s.id}</strong>
                  <span>strategy: {s.strategyId}</span>
                </div>
                <div>overallScore: {s.score.overallScore.toFixed(3)}</div>
                <div>preferenceScore: {s.score.preferenceScore.toFixed(3)}</div>
                <div>workloadScore: {s.score.workloadScore.toFixed(3)}</div>
                <div>transferScore: {s.score.transferScore.toFixed(3)}</div>
                <div>diversityScore: {s.score.diversityScore.toFixed(3)}</div>
                <div>hardViolations: {s.score.hardViolationCount}</div>
                <div>coverage: {s.validation.coverage.fullyScheduled}/{s.validation.coverage.totalAssignments} fully scheduled</div>
                <button onClick={() => onCommit(s.id)} style={{ marginTop: 8 }}>Commit</button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
