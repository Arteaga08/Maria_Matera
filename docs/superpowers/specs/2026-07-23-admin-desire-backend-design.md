# Análisis de deseo (backend) — diseño

**Fecha:** 2026-07-23 · **Bloque 2, subsistema 9/9 (último del backend admin)** · Suite: 393/393 (385 previos + 8 nuevos; los 385 incluyen los 4 del refactor statsRange)

## Qué es

"Vistos vs comprados": detectar piezas muy deseadas (vistas + wishlist) pero poco compradas.
Decisiones del usuario: señales = eventos de vista (nuevo) + `Customer.wishlist` existente;
retención = **90 días con TTL de Mongo**. Eventos **anónimos** (solo productId + timestamp —
análisis a nivel producto, sin fingerprinting ni datos personales).

## Modelo — `ProductViewEvent`

`apps/api/src/models/ProductViewEvent.ts`: `{ productId ref Product, createdAt }` (timestamps
solo createdAt). Índices: `{productId, createdAt}` (agregación por rango) y TTL
`{createdAt: 1}` con `expireAfterSeconds: 7_776_000`. TTL sobre `createdAt` y no un campo
`expiresAt` (patrón Token): la retención es política fija idéntica para todos los eventos.

## Endpoints

| Método | Ruta | Auth |
|---|---|---|
| POST | `/api/v1/events/product-view` | pública + `viewLimiter` (60/min por IP) |
| GET | `/api/v1/admin/desire` | Admin+Editor, read-only (sin audit, como los demás stats) |

### Ingesta — decisiones anti-abuso

- Joi hex24 (`desire.validators.ts`); malformado → 400.
- **Silencio deliberado**: id válido pero producto inexistente / no publicado / archivado →
  **202 sin persistir**, indistinguible del caso feliz. Evita usar el endpoint como oráculo de
  enumeración del catálogo y mantiene el dato limpio de basura de bots. El `findOne` de
  verificación es a la vez el filtro de calidad.

### Análisis — `adminDesire` (`desire.service.ts`)

- Rango vía `parseStatsRange` compartido, default 30 días.
- **4 consultas paralelas + merge en memoria** (catálogo chico, más testeable que $lookup triple):
  views por producto en rango; wishlist actual (`$unwind` — estado, sin rango); ventas realized
  en rango (calcado de `computeTopProducts`, sin `$limit`, `REALIZED_SALE_STATUSES`);
  `Product.find({isArchived: false})`.
- **Alcance**: archivados excluidos (ruido terminal); despublicados incluidos con flag
  `isPublished` (deseo acumulado sin ventas ES el insight). Solo filas con alguna señal.
- **Orden transparente sin score opaco**: `views desc → wishlistCount desc → productId asc`.
- Fila: `{ productId, name, slug, isPublished, views, wishlistCount, unitsSold, revenueCents,
  conversionPercent }` con `conversionPercent = views>0 ? round(units/views*1000)/10 : null`.
- Sin paginación (catálogo chico) — `parseListQuery` no aplica.

## Refactor compartido — `utils/statsRange.ts`

Hallazgo: las 2 copias privadas de `parseStatsRange` **no eran idénticas** (order 7d default,
customer 30d). Extraído con firma `parseStatsRange(query, defaultRangeDays)`; consumidores:
order (7), customer (30), desire (30). Comportamiento intacto — suite previa verde sin tocar
ningún test existente.

## Archivos

Nuevos: `utils/statsRange.ts`, `models/ProductViewEvent.ts`, `validators/desire.validators.ts`,
`services/desire.service.ts`, `controllers/desire.controller.ts`, `routes/desire.routes.ts`;
tests `unit/statsRange.test.ts`, `integration/desire.test.ts`.

Modificados: `order.service.ts` / `customer.admin.service.ts` (parseStatsRange → util),
`routes/index.ts` (montaje `/events` y `/admin/desire`).

## Notas

- La expiración TTL real NO se testea (el monitor de Mongo corre ~cada 60s); solo la
  definición del índice.
- El storefront (Bloque 3) disparará un POST por vista de página de producto; hasta entonces
  el panel mostrará ventas/wishlist con views en 0.
- Con esto el backend admin queda completo; falta solo el **Overview/Home** (consume stats de
  Órdenes/Inventario/CRM/Promociones/Deseo ya construidas) y después el frontend del dashboard.
