# Merge recovery ? 2026-10-08

The snapshot commit on ai_canva replaced Progress Test changes previously merged into main. This recovery restores the Progress Test implementation from propress_test, merges shared configuration instead of replacing it, and preserves the presentation module from main.

Restored: Progress Test backend/controllers/services/models/validation, independent progress_test database, admin/student routes, RBAC, math editors, app dialogs, schedule validation, tests and documentation. Latest local propress_test also contributes ModelAPI timetable intent parsing and batch lesson adjustments.

Preserved: presentation module and Canva routes, presentation database/configuration/permissions, timetable module and existing GiaPhuc auth/user/role modules. No product database records were modified. No Ai dependencies/cache were restored.

Validation:
- Frontend: 108 tests passed, production build passed.
- Backend Progress Test: 8 tests passed, including combined route and permission regression.
- Progress Test MongoDB integration passed in an isolated QA database.
- Timetable intent, batch adjustment and subject balancing: 22 tests passed.
- Presentation feature files are unchanged relative to main before recovery. No new live Canva creation was performed.

Future updates must merge feature changes onto current main; do not replace the full tree with a snapshot from an older branch. Backend regression checks that /api/progress-test/catalog, /api/timetable/schedules/committed and /api/presentations all remain mounted and protected.
