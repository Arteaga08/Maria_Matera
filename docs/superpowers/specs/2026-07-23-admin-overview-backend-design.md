# Overview/Home del dashboard (backend) — diseño

**Fecha:** 2026-07-23 · **Cierre del backend del Bloque 2** · Suite: 398/398 (393 previos + 5 nuevos)

## Qué es

Pantalla de KPIs del dashboard. **Pura composición** de las stats ya construidas en los 9
subsistemas — cero lógica de negocio nueva.

## Endpoint — `GET /api/v1/admin/overview` (Admin+Editor, read-only, sin audit)

`overview.service.ts#adminOverview(query)`:

- **Ventana única**: `parseStatsRange(query, 30)` resuelve el rango UNA vez y lo pasa como ISO
  strings a los servicios consumidos (aceptan `{from?, to?}` string; `new Date(iso)` round-trip
  exacto → cero cambios de firma). Así todas las secciones comparten la misma ventana. Nota:
  dentro del overview órdenes corre a 30 días, mientras `/admin/orders/stats` conserva su 7d —
  intencional (una ventana por pantalla).
- **`Promise.all`** de 5: `orderService.adminStats(range)`, `inventoryService.adminStats()`
  (snapshot sin rango), `customerAdminService.adminStats(range)`,
  `subscriberService.adminStats(range)`, `desireService.adminDesire(range)`.
- **Recortes de payload** (slices, no lógica): `orders.topProducts.slice(0,5)`,
  `desire.products.slice(0,5)`. El detalle vive en cada endpoint por subsistema.

### Shape `OverviewStats`

```ts
{ rangeFrom, rangeTo,
  orders: OrderStats,                 // topProducts top-5
  inventory: InventoryStats,          // snapshot de estado actual
  customers: CustomerStats,           // topCustomers ya limitado
  marketing: SubscriberStats,
  desire: { products: DesireRow[] } } // top-5
```

Los `rangeFrom/To` internos de cada sección se conservan (idénticos al top-level). Sin Joi de
query (consistente: el 400 lo lanza `parseStatsRange` en el servicio).

## Refactor coherente — subscriber.service

`subscriber.service.adminStats` tenía la **tercera copia inline** del parseo de rango → migrada
a `parseStatsRange(query, 30)` (mismo patrón ya aplicado a order/customer). Comportamiento
idéntico; export `SubscriberStatsQuery` conservado (ahora alias de `StatsRangeQuery`). Suite
previa verde sin tocar tests.

## Archivos

Nuevos: `services/overview.service.ts`, `controllers/overview.controller.ts`,
`routes/admin.overview.routes.ts`, `test/integration/overview.admin.test.ts`.
Modificados: `subscriber.service.ts` (refactor rango), `order.service.ts` (exporta type
`OrderStats`), `routes/index.ts` (montaje).

## Notas

- Tests solo verifican composición (ventana única, recortes top-5, snapshot presente), no la
  lógica interna de cada stats (ya cubierta por su propia suite).
- Con esto el **backend admin del Bloque 2 queda 100% completo** (9 subsistemas + overview).
  Sigue el **frontend del dashboard** (`apps/web` no existe aún).
