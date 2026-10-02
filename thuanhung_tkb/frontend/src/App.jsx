import { useState } from 'react';
import Generate from './pages/Generate.jsx';

const TABS = [
  { id: 'generate', label: 'AI Generate' },
  { id: 'teachers', label: 'Teachers' },
  { id: 'situation', label: 'Situation' },
];

export default function App() {
  const [tab, setTab] = useState('generate');
  return (
    <div>
      <header style={{ padding: '12px 24px', borderBottom: '1px solid #222' }}>
        <span style={{ fontWeight: 600 }}>thuanhung_tkb</span>
        <nav style={{ display: 'inline-block', marginLeft: 24 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                marginRight: 8,
                background: tab === t.id ? 'rgba(99,102,241,0.2)' : 'transparent',
                color: 'inherit',
                border: '1px solid #333',
                padding: '4px 12px',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'generate' && <Generate />}
        {tab === 'teachers' && <div style={{ padding: 24 }}>Teachers tab — driven by the same <code>preview</code> situation payload.</div>}
        {tab === 'situation' && <div style={{ padding: 24 }}>Situation tab — see the Generate output.</div>}
      </main>
    </div>
  );
}
