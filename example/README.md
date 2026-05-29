# example — un mock que cubre todos los casos

Ejemplo completo del flujo **api-spec → mock-fast**. La carpeta [`api-spec/`](api-spec/) es la
fuente de la verdad (el hub que editas); [`mock-fast.json`](mock-fast.json) es el server generado
a partir de ella. Todo lo de aquí está **verificado corriendo** contra el motor.

```bash
npx mock-fast start --file example/mock-fast.json
```

## Qué demuestra cada parte

| Ruta / carpeta | Caso que cubre |
|---|---|
| [`autenticacion-mobile-service/autenticacion/`](api-spec/autenticacion-mobile-service/autenticacion/) | URL desde carpetas (dos segmentos). `responses[]` condicionales (`match` → `when`), **fallback** sin match (401). Body con **array** (`aplicaciones:["VS"]`). Flujo 2 pasos (`totp: null` vs valor). **`dynamic`** (token, timestamp). **`behavior.rate_limit`** (lockout `on-success`). Fixtures `request-*`/`response-*`. |
| `api/` | Carpeta **namespace**: solo aporta el segmento `/api`, sin archivos. |
| `api/(publico)/` | **Route group** (Next.js): agrupa **sin** aportar segmento de URL ni auth. |
| `api/(publico)/estado/` | `GET /api/estado` público, `behavior.latency_ms`, `dynamic` (`ts`). |
| `api/protegida/_group.yml` | **`_group.yml`**: el "layout" del subárbol. Aquí vive el **seguro del token** (`auth: bearer`) + `behavior` (latencia + error_rate). Lo heredan todos los hijos. |
| `api/protegida/perfil/` | **Hereda** `auth: bearer`. `dynamic` (`sessionId` uuid, `timestamp`). |
| `api/protegida/pricing/` | **Override**: `auth: none` desactiva el guard heredado. |
| `api/protegida/usuarios/` | Carpeta que es **endpoint Y padre** (lista + hijo `[id]`). |
| `api/protegida/usuarios/[id]/` | **Param dinámico** (`[id]`→`:id`). `match` sobre `params.id` → 200, **fallback 404** (gap de cobertura cubierto). |
| `api/protegida/archivos/[...ruta]/` | **Catch-all** (`[...ruta]`→`*`). Se lee con `{{params.[0]}}`. Emitido **al final**. |

## Herencia en acción (probado)

| Petición | Resultado | Por qué |
|---|---|---|
| `GET /api/estado` sin token | 200 | grupo `(publico)`, `auth: none` |
| `GET /api/protegida/perfil` sin token | 401 | hereda `auth: bearer` de `_group.yml` |
| `GET /api/protegida/perfil` con `Bearer …` | 200 | token válido |
| `GET /api/protegida/pricing` sin token | 200 | **override** `auth: none` |
| `GET /api/protegida/usuarios/1` | 200 | `match params.id=1` |
| `GET /api/protegida/usuarios/9` | 404 | fallback |
| `GET /api/protegida/archivos/docs/informe.pdf` | 200 | catch-all, `ruta = docs/informe.pdf` |

## Mapeo carpeta → URL (convenciones de routing)

```
api-spec/autenticacion-mobile-service/autenticacion/ → POST /autenticacion-mobile-service/autenticacion
api-spec/api/(publico)/estado/                  → GET  /api/estado            ( (publico) no aporta segmento )
api-spec/api/protegida/perfil/                  → GET  /api/protegida/perfil
api-spec/api/protegida/pricing/                 → GET  /api/protegida/pricing
api-spec/api/protegida/usuarios/                → GET  /api/protegida/usuarios
api-spec/api/protegida/usuarios/[id]/           → GET  /api/protegida/usuarios/:id
api-spec/api/protegida/archivos/[...ruta]/      → GET  /api/protegida/archivos/*
```

> Notas: el JSON de las fixtures **nunca** contiene Handlebars (es dato concreto); lo dinámico vive en
> `dynamic`. Los catch-all usan `*` (no `/(.*)`) y se leen con corchetes `{{params.[0]}}`.
> `_privado/` (carpeta ignorada por el routing, para fragmentos compartidos) está disponible pero
> no se usa en este ejemplo.
