# Catalog CRUD

Teachers, classes and subjects now support create, read, update and delete in
the existing catalog pages. Each page has search/filter controls, Add and Edit
forms, save feedback and a delete confirmation. Errors keep the form open.

The teacher's home branch is selected when creating a new record and is
read-only afterward. PATCH rejects a different `homeBranchId`, including when
other valid edits are submitted with it. Preferences cannot change the home
branch or select it as a transfer wish.

| Resource | Create | Read | Update | Delete |
| --- | --- | --- | --- | --- |
| Teachers | POST `/api/teachers` | GET `/api/teachers`, GET `/api/teachers/:id` | PATCH `/api/teachers/:id` | DELETE `/api/teachers/:id` |
| Classes | POST `/api/classes` | GET `/api/classes`, GET `/api/classes/:id` | PATCH `/api/classes/:id` | DELETE `/api/classes/:id` |
| Subjects | POST `/api/subjects` | GET `/api/subjects`, GET `/api/subjects/:id` | PATCH `/api/subjects/:id` | DELETE `/api/subjects/:id` |

Teacher fields are name, code, email, phone, specializations and active status;
home branch is accepted only on creation or as an unchanged existing value.
Class fields are name, code, branch, block, homeroom teacher and active status.
Subject fields are name, code, description and active status. References are
validated; duplicate codes are rejected. Teacher names need not be unique.

Records referenced by imported assignments, curriculum, teacher specializations
or homeroom links refuse deletion with `409 RECORD_IN_USE`. Their Delete button
explains this; an operator can edit the active status instead. Unreferenced
records can be deleted. DELETE is not an automatic cascade through schedules.

CRUD changes are persisted in `catalog.json` under `CATALOG_DATA_DIR`, default
`backend/src/data/catalog/`. The configuration and documented template remain
in `src/config/index.js` and `.env.example`. The imported BSON files remain
read-only. Writes are serialized in the Node process and use a temporary file
plus atomic rename; corrupt persisted data returns an error rather than silently
restoring the legacy roster. The current storage driver is a local file, like
the existing preference/schedule persistence, not MongoDB.

The catalog feature owns its route, service and store under
`backend/src/modules/catalog/`; the former `src/api/catalog.js` route has moved
there. The frontend implementation stays under `features/catalog/` and talks
to the backend only over HTTP.

Generate and commit reload the same effective catalog used by the pages. Active
classes inherit the block's declared subject/period requirements. New or changed
demand has an unassigned teacher where no valid baseline choice exists; the
solver chooses an eligible teacher and checks every hard rule. No capacity or
transfer permission is inferred. Deactivating a teacher keeps curriculum demand
and makes it available for reassignment. Deactivating a class or subject removes
its demand from the current scheduling projection. Old accepted previews are
still revalidated against the current input before any commit.

Verification on the final implementation:

- Backend: **889 / 889 PASS**, FAIL 0, SKIP 0, concurrency 1; 295351.5543 ms.
- Frontend: **93 / 93 PASS** in 5 test files.
- Production build: **PASS**, 5.54 s.
- Seven backend CRUD regressions cover reload, immutability, references,
  invalid/duplicate data, class curriculum projection, concurrent process-local
  writes, corrupt data and the Generate API reading the updated catalog.
- Five frontend CRUD regressions cover teacher create/edit, read-only home,
  subject create/edit/confirmed delete, class selection/cancel and retained errors.
- A real browser session on an isolated temporary catalog created and edited
  all three resources, verified reload, checked read-only home and canceled a
  delete confirmation without a write. HTTP DELETE/readback then removed all
  three test records. The temporary server, tab, files and records were cleaned up.
- After cleanup, both the test catalog and live dashboard still report 40 active
  teachers, 7 branches, 113 classes, 5 active subjects, 479 assignments, 802 periods.

This CRUD verification does not change the missing transfer permissions in the
original legacy data. Its timetable readiness is documented separately in
`REAL_DATA_BLOCKED.md`.
