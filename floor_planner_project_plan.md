# 3JS Floor Planner — MVP Tech Plan & PM Backlog

> Goal: deliver a **minimal, reliable multiplayer floor‑planning tool** where a user imports a building model, invites collaborators via Google OAuth, and everyone can **select, move, rotate** objects on a grid with real‑time sync and collision constraints. No extras until the core feels solid.

---

## 0) Source of Truth
- **MVP definition** below is the bar for “done.”
- **Contracts** (REST + Socket.io) are the inter‑team handshake; changes require PR + approval.
- **Schemas** are versioned migrations; changes require migration + backfill plan.

---

## 1) MVP Scope (no time estimates)
**Must have (P0)**
1. **Auth & Rooms**
   - Google OAuth sign‑in → JWT (HttpOnly) → Socket.io auth.
   - Create **Project** → upload a **Building** model (first asset marked `is_building = true`).
   - **Room** auto‑created per project (one active room per project for MVP).
   - **Invite link** (magic link) → if not signed in, OAuth → land in room.
2. **Assets & Uploads**
   - Upload **FBX/STL → GLB** (server converts to **glTF/GLB** for web perf).
   - Store assets in GCS; metadata (units, bbox) in Postgres.
3. **Editor (Client)**
   - Load **building GLB** + reusable asset GLBs.
   - Click to **select + highlight**; **grid snap** (position) + **angle snap** (rotation).
   - **Grounding**: all items rest on floor (no floating). Simple AABB no‑overlap check.
4. **Multiplayer**
   - Presence (join/leave), **object lock on select**, **move/rotate broadcast**.
   - Redis adapter for Socket.io to scale across Cloud Run instances.
5. **Persistence**
   - Manual **Save snapshot** → write `scene_state` (list of placed instances with transform) to DB.
   - **Load latest snapshot** on join; no history/undo in MVP.
6. **Security & Ops**
   - CORS, rate limit, file type/size validation, signed GCS URLs, secrets in Cloud Run.
   - Logging for auth, uploads, socket events; basic healthcheck.

**Nice to have (P1)**
- Per‑object **labels** & simple measurements.
- Multiple **named snapshots** and **switch** between them.
- Simple **undo** (client‑side only) for last N transforms.

Out of scope (P2+)
- Photogrammetry pipeline; physics engine; pathfinding; animation tours; complex materials authoring.

---

## 2) Architecture Alignment (DevOps ↔ App)
**Given** (from DevOps): Cloud Run, Docker, Socket.io + Redis, Postgres, Google OAuth, GCS. 👍

**Additions / clarifications**
- **Asset conversion service**: containerized **`fbx2gltf`** (or Blender headless) job triggered post‑upload via queue (BullMQ on Redis). Output: `.glb` with baked transforms and meters.
- **Authoritative server**: client computes tentative move → server validates (lock + AABB) → echoes accepted transform. Prevents race/overlap.
- **Units & axes**: normalize to **meters**, **Y‑up**, **right‑handed** at import. Record scale.
- **Scene commit**: explicit `/projects/:id/scene/save` writes snapshot; no autosave to avoid conflicts.

---

## 3) Data Model (Postgres)
```sql
-- NEW
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  gcs_uri TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('building','furniture','machinery','other')) NOT NULL,
  is_building BOOLEAN DEFAULT FALSE,
  units TEXT DEFAULT 'meters',
  bbox JSONB, -- {min:[x,y,z], max:[x,y,z]}
  source_format TEXT CHECK (source_format IN ('fbx','stl')) NOT NULL,
  converted_glb_uri TEXT,
  status TEXT CHECK (status IN ('uploaded','converting','ready','failed')) DEFAULT 'uploaded',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Existing projects: add light fields
ALTER TABLE projects ADD COLUMN building_asset_id UUID REFERENCES assets(id);

CREATE TABLE scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT DEFAULT 'latest',
  scene_json JSONB NOT NULL, -- see Type below
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Invites
CREATE TABLE invites (
  token UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Scene JSON type (TS shape)**
```ts
export type SceneState = {
  grid: { size: number; angleSnapDeg: number };
  instances: Array<{
    id: string;             // stable UUID for placed instance
    assetId: string;        // FK to assets
    name?: string;
    transform: {            // all meters/radians
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    };
    meta?: Record<string, any>;
  }>;
};
```

---

## 4) Minimal REST API (Backend)
**Auth**
- `GET /auth/google` → redirect
- `GET /auth/google/callback` → set HttpOnly cookie `id_token` + redirect `FRONTEND_URL/project/:id`
- `GET /me` → current user

**Projects & Invites**
- `POST /projects` `{name}` → `{id}`
- `POST /projects/:id/invites` → `{inviteUrl}` (one‑time token)
- `POST /invites/:token/accept` → join project (requires auth)

**Assets & Uploads**
- `POST /projects/:id/assets/upload-url` `{filename, contentType, kind}` → `{signedUrl, assetId}`
- Client PUTs file to GCS → backend webhook `POST /ingest/gcs` (or poll) → enqueue convert → update `converted_glb_uri`, `status = ready`, compute `bbox`, detect units.
- `GET /projects/:id/assets` → list ready assets

**Scenes**
- `GET /projects/:id/scene` → latest `SceneState`
- `POST /projects/:id/scene/save` `{scene}` → snapshot row

---

## 5) Socket.io Contracts (Realtime)
Namespace: `/rt`; Room: `project:<id>`

**Auth**
- Client connects with `auth: { token: JWT }`.

**Presence**
- `server → client: room-state` `{ users: [...], locks: {...} }`
- `server → all: user-joined|user-left` `{ userId }`

**Locking**
- `client → server: lock` `{ instanceId }`
- `server → all: lock-granted` `{ instanceId, userId }` or `lock-denied`
- `client → server: unlock` `{ instanceId }`
- Server auto‑unlocks on disconnect / timeout.

**Transforms (authoritative)**
- `client → server: transform-propose` `{ instanceId, transform }`
- Server validates (has lock? AABB non‑overlap? inside building bounds?)
- `server → all: transform-commit` `{ instanceId, transform, version }`

**Add/Remove instances**
- `client → server: instance-add` `{ assetId, initialTransform }`
- `server → all: instance-added` `{ instance }`
- `client → server: instance-remove` `{ instanceId }`
- `server → all: instance-removed` `{ instanceId }`

**Cursor (optional P1)**
- `client → server: cursor` `{ x,y,z }` (throttled)
- `server → others: cursor` `{ userId, x,y,z }`

---

## 6) Client Implementation Notes (Three.js)
- **Loaders**: prefer `GLTFLoader` for all runtime assets; keep FBX/STL only as upload formats.
- **Selection**: raycast against instance meshes; maintain `selectedId`; outline via `OutlinePass` or emissive tweak.
- **Grid & Snapping**: origin at world (0,0,0); grid size (e.g., 0.1m); rotation snap (e.g., 15°). 
- **Dragging**: plane‑aligned gizmo (XZ plane); while dragging, show ghost + AABB. On drop → send `transform-propose`.
- **Grounding**: on load and on transform, set `position.y` so **bbox.min.y == 0** (or floor elevation if multi‑floor later).
- **Collision**: client computes tentative AABB; rejects if intersects any other locked/placed AABB; server re‑checks.
- **Performance**: use `MeshoptDecoder`, draco if needed; frustum culling; static building as single `Scene`.

---

## 7) Conversion Pipeline
1. **Upload** → GCS (`raw/…`)
2. **Job** enqueued `{assetId, gcsUri, sourceFormat}`
3. Worker runs `fbx2gltf` (or Blender) → writes `glb/…` → probes bbox, vertex count, unit scale
4. Update DB (`converted_glb_uri`, `status = 'ready'`, `bbox`, `units = 'meters'`)
5. Notify room if waiting on asset → `server → all: asset-ready {assetId, glbUri}`

Validation
- Allowed: `fbx, stl`; max size (e.g., 100MB dev / 500MB prod)
- Reject with clear error if too big or not convertible

---

## 8) Acceptance Checklist (PM)
**Auth & Invite**
- [ ] New user can sign in with Google; `/me` returns profile
- [ ] Creating project yields ID; invite link works for a second account

**Upload & Asset Ready**
- [ ] Upload FBX building → status moves `uploaded → converting → ready`
- [ ] Building loads in client as GLB; appears grounded; correct scale

**Editor Core**
- [ ] Click selects object; visible highlight
- [ ] Drag moves on grid; Y locked; rotation snaps
- [ ] Two objects cannot overlap (client rejects; server also rejects if forced)

**Multiplayer**
- [ ] Two browsers in same room see each other’s presence
- [ ] Selecting an instance locks it for others; move events stream smoothly (<150ms delay locally)
- [ ] Disconnect auto‑releases lock

**Persistence**
- [ ] Save scene; refresh → load latest snapshot
- [ ] Snapshot includes grid settings and all instance transforms

**Security/Ops**
- [ ] Only logged‑in users can join room
- [ ] Uploads validated; GCS objects private; served via signed URL
- [ ] Basic logs appear in Cloud Logging (auth, upload, convert, socket)

---

## 9) Roles & Ownership (RACI‑lite)
**DevOps** (D): Cloud Run, Redis, Postgres, GCS, CI/CD, secrets, signed URLs, conversion worker infra.

**App Dev** (A): Three.js client, REST/Socket handlers, selection/drag/locks, AABB, save/load.

**PM/You + ChatGPT** (C): enforce contracts, review PRs for scope creep, accept features against checklist.

**Responsible examples**
- Signed upload URL endpoint → DevOps (D), App Dev (A), PM (C)
- Socket auth middleware → App Dev (A), DevOps (C)
- GLB conversion container → DevOps (A), App Dev (C)
- AABB server validate → App Dev (A), PM (C)

---

## 10) Configuration & Secrets
```
FRONTEND_URL, BACKEND_URL
JWT_SECRET, SESSION_SECRET
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
DATABASE_URL, REDIS_URL
GCS_BUCKET, GCP_PROJECT_ID, GCP_SA_JSON (for CI)
MAX_UPLOAD_MB, ALLOWED_EXTS = fbx,stl
```

CORS
- Allow exact domains; include Socket.io `withCredentials`.

---

## 11) Example Endpoint & Event Payloads
**Create signed upload URL**
```http
POST /projects/:id/assets/upload-url
{
  "filename": "forklift.fbx",
  "contentType": "model/vnd.fbx",
  "kind": "machinery"
}
→ { "assetId": "…", "signedUrl": "https://storage.googleapis.com/..." }
```

**Transform round‑trip**
```ts
// client → server
{
  type: 'transform-propose',
  roomId: 'project:<id>',
  instanceId: 'uuid',
  transform: { position:[1,0,2], rotation:[0,1.57,0], scale:[1,1,1] }
}
// server → all
{
  type: 'transform-commit',
  instanceId: 'uuid',
  transform: { ... },
  version: 42,
  by: 'userId'
}
```

---

## 12) Test Plan (Manual Smoke)
1. Start stack via `docker-compose`.
2. Sign in on Tab A & B (different Google accounts).
3. Project create on A; invite B via link; B lands in room.
4. Upload building FBX; wait → ready; loads.
5. Add two assets; place them; ensure snap + rotation works.
6. A selects object (lock); B cannot move it; on unlock B can.
7. Save; reload B; positions persist.

---

## 13) Backlog (Prioritized)
**P0**
- [ ] OAuth + JWT cookie; `/me`
- [ ] Projects CRUD minimal; invites
- [ ] Signed uploads → GCS; conversion worker to GLB
- [ ] GLB loader; selection/highlight; grid & angle snap
- [ ] Socket rooms; locks; transform propose/commit; Redis adapter
- [ ] Server AABB validate; ground snap
- [ ] Save/Load latest snapshot
- [ ] Basic logs/metrics; healthcheck

**P1**
- [ ] Multiple named snapshots; switcher UI
- [ ] Per‑object labels; simple tape measure
- [ ] Client undo (last N transforms)
- [ ] Cursor broadcast (ghost pointers)

**P2**
- [ ] Multi‑floor support; floor elevation map
- [ ] Physics engine (Ammo/Cannon) for richer constraints
- [ ] Import DWG/IFC; materials palette

---

## 14) Risks & Mitigations
- **FBX at runtime is heavy** → convert to GLB offline; compress; mesh‑opt.
- **Race conditions** → locks + server authoritative commit.
- **Unit/axis mismatches** → normalize at conversion; record scale.
- **Large building perf** → decimate meshes; split building into static BVH for faster raycasts.
- **Cloud Run cold starts** → keep Redis/DB external; consider min instances = 1 for backend.

---

## 15) Definition of Done (MVP)
- A new user can create a project, upload a building, invite a collaborator, and both can **select, move, and rotate** objects on a snapped grid **without overlaps**, and **save/reload** the arrangement. Logs show expected events; assets are private in GCS and served via signed URLs.

---

## 16) Team Hand‑Off Notes
- This doc is the working contract. Keep PRs small and mapped to backlog checkboxes.
- PM reviews: 
  - API responses match samples 
  - Socket payloads/events match names 
  - DB rows created/updated as specified.
