# Paso 5, Frente 2 — Tests de servicio de catálogo + 2 fixes críticos

**Fecha:** 2026-07-23 · Suite: 464/464 (402 previos + 62 nuevos)

## Objetivo

Cerrar el hueco de cobertura de `variant/product/category/collection.service.ts` (antes: 0 tests
en variant, solo 5 casos indirectos vía `catalog.test.ts` para el resto). Doble propósito:
**caracterización** (documentar el comportamiento real, gaps incluidos, como red de seguridad
para refactors) + **2 fixes reales** decididos explícitamente por el usuario.

## Archivos de test (nuevos)

- `test/integration/category.service.test.ts` (14 casos)
- `test/integration/collection.service.test.ts` (11 casos)
- `test/integration/variant.service.test.ts` (12 casos)
- `test/integration/product.service.test.ts` (25 casos)

Patrón: import directo del servicio (sin HTTP), `actor` fijo, verificación de retorno + estado
persistido + `AuditLog`, `.rejects.toMatchObject({statusCode})` para errores.

## Fixes aplicados (TDD real, rojo→verde)

1. **`category.service.ts#create`**: un `skuPrefix` duplicado ya no explota como error crudo de
   Mongo (`E11000`) — se captura y relanza como `AppError("Ya existe una categoría con ese
   prefijo de SKU.", 400)`.
2. **`category.service.ts#remove`**: ahora rechaza con `AppError(..., 409)` si existe un
   `Product` activo (`isArchived:false`) con esa `categoryId` — ya no se pueden dejar productos
   huérfanos al "eliminar" una categoría en uso. Un producto ya archivado no bloquea.
3. **`collection.service.ts#remove`**: mismo patrón sobre `Product.collectionId` (campo opcional).

Verificado antes de aplicar: ningún test existente dependía del comportamiento viejo (nadie
borraba categoría/colección con productos activos, nadie creaba `skuPrefix` duplicado a
propósito) — cero regresiones.

## Gaps documentados, NO corregidos (candidatos a un frente futuro)

- **Variant**: sin check de "última variante activa" al archivar (el producto sigue `isPublished`
  con cero variantes disponibles); no regenera el SKU si el producto padre cambia de categoría;
  sin bloqueo para editar/archivar variantes de un producto ya archivado; sin check de
  stock/reservas pendientes antes de archivar.
- **Product**: filtro público con `category`/`collection` de slug inexistente devuelve lista
  vacía silenciosa (no 400); `update` no resincroniza el `slug` si cambia el `name`; `setPublished`
  permite republicar un producto archivado (`isArchived:true` + `isPublished:true` simultáneo,
  sin guarda); `archive` no cascadea a `ProductVariant` (variantes quedan huérfanas activas).
- **Category/Collection**: `update` opera sobre un registro ya "removido" (`isActive:false`) sin
  restricción; la acción auditada en `remove` es `"ARCHIVE"`, no coincide con el nombre de la
  función.

## Archivos modificados

`services/category.service.ts` (fixes 1-2, import de `Product`), `services/collection.service.ts`
(fix 3, import de `Product`).

## Verificación

464/464 tests, typecheck, build y lint limpios.

## Pendiente del Paso 5

Frentes 3-5: CI + `npm audit`, Sentry (decisión abierta), security-review final.
