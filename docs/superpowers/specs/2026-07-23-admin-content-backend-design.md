# Editor de contenido (backend) — diseño

**Fecha:** 2026-07-23 · **Bloque 2, subsistema 8/9** · Suite: 381/381 (345 previos + 36 nuevos)

## Alcance (decidido con el usuario)

Maria (Editor o Admin) edita desde el dashboard: hero del home (slides imagen/video + CTA),
novedades y best sellers (productos curados), y barra/pop-up de anuncio. Vigencia solo con
`isActive` (sin fechas de campaña). Videos suben a Cloudinary. Fuera de alcance: SEO,
page-builder, scheduling, frontend.

## Modelo — singleton `HomeContent`

`apps/api/src/models/HomeContent.ts` — patrón singleton de `Settings.ts` (`_id` fijo
`HOME_CONTENT_ID = ...0002`, upsert race-safe). Secciones tipadas:

- `hero.slides[]`: `mediaType` (`HeroMediaType` image/video), `mediaUrl`, `title?`, `subtitle?`,
  `ctaLabel?`, `ctaHref?`, `isActive` (default true).
- `newArrivals` / `bestSellers`: `{ productIds[] (ref Product), isActive }`.
- `announcement`: `{ text (max 200), href?, type (AnnouncementType bar/popup), isActive (default false) }`.

Enums nuevos en `packages/shared/src/enums.ts` (+ re-export en `index.ts`): `HeroMediaType`,
`AnnouncementType`.

## Endpoints

| Método | Ruta | Auth |
|---|---|---|
| GET | `/api/v1/content/home` | pública |
| GET | `/api/v1/admin/content/home` | Admin+Editor |
| PUT | `/api/v1/admin/content/home/hero` | Admin+Editor |
| PUT | `/api/v1/admin/content/home/new-arrivals` | Admin+Editor |
| PUT | `/api/v1/admin/content/home/best-sellers` | Admin+Editor |
| PUT | `/api/v1/admin/content/home/announcement` | Admin+Editor |
| POST | `/api/v1/admin/media/video` | Admin+Editor |

**PUT por sección** (no PUT del documento completo): dos admins editando secciones distintas no
se pisan (`$set` atómico por sección) y la auditoría queda granular (`module: "content"`,
actions `UPDATE_HERO` / `UPDATE_NEW_ARRIVALS` / `UPDATE_BEST_SELLERS` / `UPDATE_ANNOUNCEMENT`,
con before/after).

## Decisiones clave

- **Validación doble de productos curados**: al guardar, `assertProductsCurated` rechaza con 400
  ids inexistentes / no publicados / archivados (feedback inmediato); al leer, `getPublic`
  filtra de nuevo (`isPublished: true, isArchived: false`) — un producto archivado *después*
  de curarse se cae en silencio y el home nunca se rompe.
- **Orden curado preservado**: `$in` de Mongo no garantiza orden → reordenado en memoria con Map.
- **Shape público estable**: siempre 4 llaves (`hero`, `newArrivals`, `bestSellers`,
  `announcement: null` si inactivo); slides inactivos filtrados; sección inactiva → `products: []`.
  Productos poblados con campos mínimos: `id, name, slug, priceCents, currency, image`.
- **Links seguros**: `ctaHref`/`href` aceptan URL https **o** ruta interna (`/^\/[^\s]*$/`);
  `javascript:`/http rechazados. CTA completo o ausente (`.and("ctaLabel","ctaHref")`).
- **Video**: endpoint separado `POST /admin/media/video` (field `video`, 100 MB, whitelist
  mp4/webm/mov + magic bytes con `file-type`); `media.service.uploadVideo` con
  `resource_type: "video"`. Nota consciente: multer memory storage carga hasta 100 MB en RAM
  por request — aceptable para endpoint admin de bajo tráfico.
- **Rendimiento del storefront** (duda del usuario): un GET a un documento pequeño, cacheable
  (ISR/revalidate); media por CDN de Cloudinary. Contenido editable ≠ home lento.

## Archivos

Nuevos: `models/HomeContent.ts`, `services/content.service.ts`, `validators/content.validators.ts`,
`controllers/content.controller.ts`, `routes/content.routes.ts`; tests
`unit/media.service.video.test.ts`, `unit/content.validators.test.ts`,
`integration/media.video.test.ts`, `integration/content.service.test.ts`,
`integration/content.routes.test.ts`.

Modificados: `packages/shared/src/{enums,index}.ts`, `middlewares/upload.ts` (multer de video),
`services/media.service.ts` (`uploadVideo`), `controllers/media.controller.ts`,
`routes/media.routes.ts`, `routes/index.ts` (montaje `/content` y `/admin/content`).

## Pendiente conocido (pre-existente, no tocado)

`pnpm lint` falla por regla `import/first` no registrada en 2 tests de webhooks — error de
config previo a este subsistema.
