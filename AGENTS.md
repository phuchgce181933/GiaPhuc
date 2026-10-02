# AGENTS.md

Rules and conventions for this project. Keep this file short. The rule below is the one that matters most.

> **Code must have a clear, consistent location.**
> If code belongs to a feature, place it inside that feature.
> If code is shared, place it inside the shared area.
> Do not create multiple folders that serve the same purpose.

---

## 1. Project structure

The repo is split into two independent applications plus shared docs:

```
.
├── backend/        # Node.js + Express API
├── frontend/       # React SPA
├── AGENTS.md       # This file
└── README.md       # Top-level readme
```

Each app has its own `package.json`, its own `.env`, and runs on its own port. Do not import across the boundary — frontend talks to backend only via HTTP.

---

## 2. Backend (Node.js + Express + MongoDB)

```
backend/
├── src/
│   ├── config/         # DB connection, env loading, third-party config
│   ├── modules/        # Feature-based modules (one folder per feature)
│   ├── middlewares/    # Express middlewares (auth, rbac, error, validate)
│   ├── shared/         # Truly shared code reused by many modules
│   ├── routes/         # Top-level route registry (mounts module routes)
│   ├── app.js          # Express app (middleware + routes)
│   └── server.js       # Entry point (starts HTTP + DB)
├── tests/              # Backend tests
├── .env                # Local env (gitignored)
├── .env.example        # Documented env template
└── package.json
```

### Module layout

Each module under `src/modules/<feature>/` contains only the files it actually needs. A typical module:

```
modules/staff/
├── staff.controller.js   # HTTP layer (req/res)
├── staff.service.js      # Business logic
├── staff.model.js        # Mongoose model
├── staff.route.js        # Express router
└── staff.validation.js   # Request validation schemas (e.g. zod / joi)
```

Rules:

- A module must export its router from `<feature>.route.js`.
- Controllers may depend on Services. Services must not depend on Controllers.
- Repositories are created only when there is a real reason to abstract persistence. Default to keeping data access in `service.<feature>.js` via the Mongoose model.
- Do not force every module to have every file. Skip files that are empty or unused.
- A module name is singular (`staff`, `user`, `role`, `permission`, `auth`).

### Auth + RBAC

- `modules/auth/` owns login, logout, refresh, password hashing, JWT issue/verify.
- `modules/user/` owns the user account record.
- `modules/role/` owns roles. A role references permission keys (strings).
- `modules/permission/` owns the catalog of permission codes (e.g. `staff:read`).
- `middlewares/auth.middleware.js` verifies JWT and attaches `req.user`.
- `middlewares/rbac.middleware.js` checks the required permission(s).
- Do not put auth/RBAC logic inside feature modules — extend `middlewares/`.

### Shared code

Anything used by two or more modules lives in `src/shared/`. Single-use helpers stay inside the module that uses them.

### Environment variables

- All env access goes through `src/config/index.js`. Do not call `process.env` from feature code.
- `.env.example` is the source of truth for required keys. Add new keys there when introducing them.

---

## 3. Frontend (React)

```
frontend/
├── src/
│   ├── assets/        # Images, fonts, static files
│   ├── components/
│   │   ├── ui/        # Generic UI primitives (Button, Input, Card, ...)
│   │   ├── layout/    # Layout pieces used by more than one page
│   │   └── common/    # Other cross-feature components
│   ├── features/      # Feature modules (mirror backend modules)
│   ├── layouts/       # Top-level app layouts (AuthLayout, AdminLayout, ...)
│   ├── pages/         # Route components (one per route)
│   ├── hooks/          # Cross-feature React hooks
│   ├── services/       # API client modules (axios instances + endpoints)
│   ├── routes/         # Router config + route guards
│   ├── lib/            # Framework wiring (axios, query client, providers)
│   ├── utils/          # Pure utility functions
│   ├── types/          # Shared TS types / JSDoc typedefs
│   ├── App.jsx
│   └── main.jsx
├── tests/             # Frontend tests
└── package.json
```

### Feature layout

Each feature under `src/features/<feature>/` is self-contained:

```
features/<feature>/
├── components/    # UI used only by this feature
├── pages/         # Screen-level components if the feature owns full pages
├── hooks.js       # Feature-specific hooks (or hooks/<name>.js if many)
├── service.js     # API calls for this feature
├── store.js       # state (zustand / redux / context) if needed
└── index.js        # Public exports (optional)
```

Rules:

- Feature-specific code lives inside the feature. Do not promote it to `components/`, `hooks/`, or `services/` unless another feature genuinely needs it.
- `components/ui/` holds only generic primitives with no business meaning.
- `components/layout/` holds pieces shared across many pages (Sidebar, Topbar).
- `components/common/` is for the rest — only when something is truly cross-feature.
- Do not create both `components/common/` and `components/shared/` — one is enough. Use the one that already exists.

### Auth + RBAC on the frontend

- `features/auth/` owns the auth store/context, login/register screens, and the API calls.
- `routes/` contains the router and a `<RequireAuth>` / `<RequireRole>` guard component.
- The frontend mirrors backend permission strings exactly (e.g. `staff:read`). Permission constants live next to where they are checked.

### Environment variables

- Vite env vars are prefixed `VITE_`.
- All env access goes through `src/lib/env.js`. Do not read `import.meta.env` directly outside that one file.

---

## 4. Naming convention

- Files inside a module use the module name as a prefix: `staff.controller.js`, `staff.service.js`, `staff.model.js`. Drop the prefix when the file is outside a module folder (e.g. `Button.jsx` inside `components/ui/`).
- One default export per file is preferred. Named exports are fine for utilities.
- React components are PascalCase files: `LoginForm.jsx`, `UserTable.jsx`.
- Hooks start with `use`: `useAuth.js`, `useStaffList.js`.
- Constants are `UPPER_SNAKE_CASE`: `PERMISSIONS`, `ROLES`, `API_BASE_URL`.

---

## 5. General rules

- Clean → Simple → Consistent → Maintainable. In that order.
- No over-engineering. No abstractions created "just in case."
- Before creating a new file, search the project for something similar that already exists and reuse it.
- No two folders with the same purpose. If a new folder looks like an existing one, put the file in the existing folder instead.
- Business logic, API contracts, authentication, and RBAC must not change during structural refactors.
- UI/UX design follows `.cursor/skills/ui-ux-pro-max/` (Premium dark SaaS direction). UI redesigns are a separate step and never happen during structural refactors.