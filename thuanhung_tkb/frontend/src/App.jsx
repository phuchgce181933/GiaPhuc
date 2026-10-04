/**
 * App shell.
 *
 * Phase 32 ships one screen, so there is one tab and no router. The
 * previous shell had three tabs — "AI Generate", "Teachers",
 * "Situation" — and the latter two were placeholders that rendered a
 * sentence pointing back at the generate output. A tab that only says
 * "look at the other tab" is a dead end, so they are gone rather
 * than kept as stubs.
 *
 * `SchedulePage` is reached through `pages/Generate.jsx`, which is a
 * re-export of the feature's own screen, so this file references one
 * route component and the feature stays self-contained.
 *
 * PHASE 33: the subtitle used to say "preview only", which was an
 * accurate Phase 32 statement and became a FALSE one the moment a
 * commit could write. It now names what the screen actually does:
 * generate a preview, save what you confirm. The mode itself is
 * reported from `/api/schedules/health` on the page, so the shell
 * never hard-codes a capability the deployment might not have.
 */

import Generate from './pages/Generate.jsx';

export default function App() {
  return (
    <div>
      <header className="tkb-app-header">
        <span className="tkb-app-title">thuanhung_tkb</span>
        <span className="tkb-app-sub">Phase 33 · generate, then save what you confirm</span>
      </header>
      <main>
        <Generate />
      </main>
    </div>
  );
}
