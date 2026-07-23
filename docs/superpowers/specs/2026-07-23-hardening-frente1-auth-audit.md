# Paso 5, Frente 1 — Auditoría de auth admin + 2FA

**Fecha:** 2026-07-23 · Suite: 402/402 (398 previos + 4 nuevos; incluye fix de un test existente)

## Hueco cerrado

Todas las mutaciones de negocio ya auditaban (`recordAudit`), pero el subsistema de auth admin
no: login admin y cambios de postura de 2FA no dejaban rastro de quién los hizo.

## Cambios

- **`adminAuth.service.login`** (`module: "auth"`, `action: "ADMIN_LOGIN"`): audita tras login
  exitoso (actor = el propio admin, `targetId = admin.id`, `ip`). Login fallido (contraseña o
  correo inexistente) **no** va al AuditLog — `actorId` es ObjectId requerido en el modelo, y un
  correo inexistente no tiene actor; en su lugar se loguea con `pino.warn` (`admin_login_failed` /
  `admin_login_failed_2fa`), que ya redacta PII/secretos. El `loginLimiter` sigue acotando el
  intento de fuerza bruta.
- **`twoFactor.service`**: `setupTwoFactor`/`enableTwoFactor`/`disableTwoFactor` ahora reciben
  `Actor` (antes `adminId: string`) y auditan `SETUP_2FA`/`ENABLE_2FA`/`DISABLE_2FA`. El secreto
  TOTP y el código nunca entran al payload de auditoría (verificado en test).
- **`adminAuth.controller.ts`**: pasa `req.ip` a login y `getActor(req)` a los handlers de 2FA.

## Efecto lateral corregido

`audit.admin.test.ts` creaba un admin y hacía login real vía HTTP como fixture (`agentWithRole`).
Con el cambio, ese login ahora también audita — y como es más reciente que las entradas
manuales backdateadas del test, el `.find(actorUsername === ...)` empezaba a resolver la
entrada de login en vez de la fixture. Se corrigió filtrando también por `module: "test-module"`
(el módulo propio de esa fixture) para desambiguar.

## Archivos

Modificados: `services/adminAuth.service.ts`, `services/twoFactor.service.ts`,
`controllers/adminAuth.controller.ts`, `test/integration/audit.admin.test.ts` (fix).
Nuevo: `test/integration/auth.audit.test.ts`.

## Pendiente del Paso 5 (hardening)

Frentes 2-5: tests de servicio faltantes (variant/product/category/collection.service),
CI + `npm audit`, Sentry (pendiente costo/decisión del usuario — plan gratis disponible),
security-review final. Jobs en background: **cerrado** (cron+TTL de Mongo, no se reabre).
