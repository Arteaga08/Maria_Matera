# Paso 5, Frente 3 — CI (GitHub Actions) + npm audit

**Fecha:** 2026-07-23 · Greenfield: no existía `.github/` en el repo.

## Objetivo

Automatizar en cada push/PR lo que hasta ahora eran solo comandos locales (`build`, `typecheck`,
`lint`, `test`) y sumar `pnpm audit` como verificación nunca antes corrida.

## Verificación previa (antes de escribir el workflow)

```
pnpm audit --audit-level=high        → 7 vulnerabilidades (3 moderate, 3 high, 1 critical)
pnpm audit --audit-level=high --prod → limpio (0 vulnerabilidades)
```

Las 4 que superan `high` son de devDependencies (`vitest`/`vite`, `brace-expansion` transitiva de
`eslint`/`typescript-eslint`) — nunca corren en el runtime del API desplegado. Esto decidió el
diseño de dos pasos de audit (ver abajo).

## Diseño

- **Un solo job secuencial** (`.github/workflows/ci.yml`, job `verify`, `ubuntu-latest`): el orden
  real de dependencia (`shared` debe compilar antes que `api` lo resuelva vía `workspace:*`) ya
  fuerza secuencia; jobs paralelos duplicarían el setup completo sin beneficio real para un repo
  de una persona.
- **Triggers**: `push`/`pull_request` a `main` + `workflow_dispatch`. `concurrency` con
  `cancel-in-progress` para no gastar minutos en runs obsoletos.
- **Setup**: `pnpm/action-setup@v4` (`9.12.0`, igual al `packageManager` del root) **antes** de
  `actions/setup-node@v4` (`node-version-file: .nvmrc` = 20, `cache: pnpm`) — orden requerido para
  que `setup-node` resuelva la cache de pnpm.
- **Sin secrets de GitHub**: `apps/api/test/setup.ts` inyecta con `??=` todos los placeholders que
  `config/env.ts` exige fail-fast — la suite corre out-of-the-box en CI.
- **Cache de `mongodb-memory-server`**: `actions/cache@v4` sobre `~/.cache/mongodb-binaries`, key
  con hash del lockfile — evita re-descargar `mongod` en cada run.
- **Orden de pasos**: install → build → typecheck → lint → test → audit (barato→caro; build
  primero porque nada más funciona si `shared` no compila).
- **Audit en dos pasos**: `--prod` bloqueante (limpio hoy, puede bloquear con confianza desde el
  día 1); árbol completo con `continue-on-error: true` (visibilidad de vulnerabilidades de
  toolchain sin bloquear por dependencias que nunca llegan a producción).

## Archivos

Nuevo: `.github/workflows/ci.yml` (11 pasos). Modificado: `README.md` (badge de CI).

## Validación realizada (sin push)

`actionlint` no estaba instalado — no se instaló sin permiso explícito. Validación alternativa:
sintaxis YAML parseada con Ruby (`YAML.load_file`, stdlib), que detectó y permitió corregir un
error real: el nombre de un step (`"Build (workspace-aware: shared antes de api)"`) tenía un
colon sin comillas que rompía el parseo YAML — corregido a un em dash. Confirmado tras el fix:
11 steps, orden correcto. (Nota: el parser interpreta `on:` como booleano `true` en vez de string
— artefacto conocido de YAML 1.1 en parsers no-GitHub, no afecta a Actions, que trata `on:`
literalmente por convención universal.)

## Pendiente — requiere acción del usuario

El workflow **no se ha commiteado ni pusheado**. Próximo paso: commit en una rama feature (ej.
`ci/frente3-pipeline`), push, abrir PR hacia `main` — la pestaña Actions de GitHub da la
validación real (sintaxis + ejecución). Confirmar ahí que los 11 pasos corren, que el audit
informativo reporta las 4 vulnerabilidades conocidas sin romper el job, y que el tiempo total es
razonable (~3-5 min esperado).

## Pendiente del Paso 5

Frentes 4 (Sentry, decisión abierta) y 5 (security-review final).
