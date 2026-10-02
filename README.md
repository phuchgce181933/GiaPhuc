# Gia Phuc

User Management platform — Node.js + Express API (`backend/`) and React SPA (`frontend/`).

See [`AGENTS.md`](./AGENTS.md) for project structure, naming, and module rules.

---

## Quick start

### 1. Backend

```bash
cd backend
copy .env.example .env       # Windows; on Linux/macOS use: cp .env.example .env
# Edit .env — set MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET, MAIL_*, etc.
npm install
npm run seed                 # Creates system admin + permission profile
npm run dev                          # http://localhost:5000
```

### 2. Frontend

```bash
cd frontend
copy .env.example .env       # Windows; on Linux/macOS use: cp .env.example .env
npm install
npm run dev                          # http://localhost:5173
```

The frontend's Vite dev server proxies `/api/*` to `http://localhost:5000`, so you can sign in immediately.

### Default admin (after seed)

| Field    | Value                       |
| -------- | --------------------------- |
| Email    | `SEED_ADMIN_EMAIL` from env |
| Password | `SEED_ADMIN_PASSWORD` from env |

Change both via the `.env` file before running `npm run seed` in any non-dev environment.

---

## What this app does

Implements the **User Management** spec in Vietnamese (`Yêu cầu chức năng: Quản lý User`).

| Capability | Where |
| --- | --- |
| Admin creates user, sends notification email | `POST /api/users` — `user.service.js#createUser` |
| Admin reads / updates any user | `GET /api/users`, `PATCH /api/users/:id` |
| Admin changes role / status | `PATCH /api/users/:id/role`, `PATCH /api/users/:id/status` |
| Admin deletes user | `DELETE /api/users/:id` |
| Role + permission catalog (RBAC) | `GET /api/permissions`, `GET /api/roles`, `POST /api/roles`, … |
| User views / edits own profile | `GET /api/users/me`, `PATCH /api/users/:id/profile` (self) |
| Login / refresh / change password | `POST /api/auth/login`, `/auth/refresh`, `/auth/change-password` |

Permission keys live in **one place** on each side — `backend/src/shared/permissions.js` and `frontend/src/lib/env.js` — and are mirrored exactly. RBAC is enforced both in route guards (UI) and in middleware (API).

---

## Endpoints summary

```
GET    /api/health
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/change-password        (auth)

GET    /api/users                       (user:read)
GET    /api/users/me                    (auth)
GET    /api/users/:id                   (self | profile:read:any)
POST   /api/users                       (user:create)
PATCH  /api/users/:id                   (user:update)
PATCH  /api/users/:id/profile           (profile:update:self | profile:update:any, self)
PATCH  /api/users/:id/role              (user:change-role)
PATCH  /api/users/:id/status            (user:change-status)
DELETE /api/users/:id                   (user:delete)

GET    /api/roles                       (role:read)
POST   /api/roles                       (role:manage)
PATCH  /api/roles/:id                   (role:manage)
DELETE /api/roles/:id                   (role:manage)
GET    /api/permissions                 (role:read)
```

---

## Permission catalog

| Key | Description |
| --- | --- |
| `user:read` | List and view users |
| `user:create` | Create a new user (triggers welcome email) |
| `user:update` | Update any user |
| `user:delete` | Delete a user |
| `user:change-role` | Reassign a user's role |
| `user:change-status` | Activate / lock / deactivate a user |
| `profile:read:self` | Read your own profile |
| `profile:update:self` | Edit your own profile |
| `profile:read:any` | Read any user's profile |
| `profile:update:any` | Edit any user's profile |
| `role:read` | List roles and permissions |
| `role:manage` | Create, edit, delete roles |
| `auth:login` | Sign in (granted to the default `user` role) |

The seeded `admin` role holds **all** permissions; the seeded `user` role holds the auth + own-profile permissions. `seed.js` overwrites the admin password from env on every run — keep it idempotent in CI, rotate before production.

---

## Notes on env / git

- `backend/.env` and `frontend/.env` are gitignored. The committed `.env.example` files contain placeholders only — never real secrets.
- The JWT, MongoDB, mail, and other secrets in this repo's history were removed during a security pass; rotate any that were ever used in production.
- All env access goes through `backend/src/config/index.js` and `frontend/src/lib/env.js`. Do not read `process.env` or `import.meta.env` from feature code.