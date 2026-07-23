# Paso 5, Frente 4 — Sentry (monitoreo de errores)

**Fecha:** 2026-07-23 · Suite: 469/469 (464 previos + 5 nuevos)

## Qué se integró

Sentry (`@sentry/node ^10.67.0`), envuelto en un módulo propio [config/sentry.ts](apps/api/src/config/sentry.ts)
— igual que el proyecto ya hace con Cloudinary/email, nunca se importa un SDK externo directo en
código de negocio. `initSentry()` / `captureException()` / `flush()` son **no-op si `SENTRY_DSN`
no está configurado** — el backend arranca y opera igual en dev/test sin ninguna cuenta de Sentry.

## Decisión de diseño: sin `Sentry.setupExpressErrorHandler`

Se optó por **no** usar la instrumentación automática de Sentry sobre Express. En su lugar, el
único punto de captura HTTP es el [errorHandler.ts](apps/api/src/middlewares/errorHandler.ts)
global ya existente, que ya distingue error operacional (4xx esperado) de no-operacional (500
real) — así Sentry solo recibe 500s genuinos, sin ruido de logins fallidos, 404s o validaciones.
Esto también cubre los webhooks de Stripe/MercadoPago automáticamente (llegan al mismo
`errorHandler` vía `asyncHandler` si `dispatchEvent` falla) sin tocar `webhook.controller.ts` ni
arriesgar captura duplicada.

## Puntos de captura

1. **`errorHandler.ts`**: `captureException(error, { extra: { path } })` solo en la rama
   `statusCode >= 500`.
2. **`server.ts`**: `unhandledRejection` / `uncaughtException` / fallo de arranque —
   `captureException` + `await flush()` **antes** de `process.exit(1)` (si no, el proceso muere
   antes de que Sentry envíe el evento).
3. **`server.ts`**: catch de `reconcilePendingOrders` (cron de reconciliación de pagos) —
   `captureException(error, { tags: { job: "reconcilePendingOrders" } })`.

## Archivos

Nuevo: `src/config/sentry.ts`, `test/unit/sentry.test.ts`, `test/unit/errorHandler.test.ts`
(no existía ninguno antes). Modificados: `config/env.ts` (+`sentryDsn` opcional), `server.ts`
(init + 3 puntos de captura), `middlewares/errorHandler.ts` (captura en rama 500),
`test/unit/env.test.ts` (+1 caso), `.env.development.example` / `.env.production.example`
(+bloque `SENTRY_DSN`), `apps/api/package.json` (+dependencia).

## Pendiente — acción del usuario

El código funciona igual sin Sentry configurado (inerte por diseño). Para activarlo de verdad:
1. Crear cuenta gratis en sentry.io (plan Developer, ~5k errores/mes, sin tarjeta).
2. Crear un proyecto Node/Express, copiar el DSN.
3. Pegarlo en `SENTRY_DSN=` de `.env.production.local` (y opcionalmente `.env.development.local`
   si se quiere probar en dev).

## Pendiente del Paso 5

Frente 5: `security-review` final de toda la superficie — el último frente del hardening.
