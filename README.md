# mock-fast

Servidor mock declarativo con un DSL JSON pequeño y escalable. Un único comando, herencia de rutas anidadas, autenticación heredada, errores aleatorios, latencias variables, rate-limit por usuario, templating con Faker, hot reload.

mock-fast no reinventa el motor: se apoya en [@mocks-server/main](https://www.mocks-server.org) y le añade encima un DSL más conciso, herencia entre rutas y un pipeline de extensiones que se amplía con un solo archivo.

## Filosofía

- **Una línea para arrancar.** Defaults razonables hard-coded — puerto, host, CORS, hot reload, header de auth. Si querés algo no-estándar, va al JSON, no a flags.
- **El JSON es la fuente de verdad.** Editás un archivo, el servidor recarga.
- **Anidación con herencia.** Una vez declarás `requireAuth` en la raíz protegida, todas las hijas la heredan. Las URLs se concatenan.
- **Escalable.** Añadir una extensión nueva = un archivo en `src/extensions/`. El pipeline las encadena.

## Instalación

```bash
npm install --save-dev mock-fast
```

## Hello world

Creá un archivo `mock-fast.json` en la raíz del proyecto:

```json
{
  "routes": [
    {
      "id": "health",
      "url": "/health",
      "response": { "status": 200, "body": { "ok": true } }
    }
  ]
}
```

Arrancá:

```bash
npx mock-fast start
```

```
[mock-fast] listening on http://127.0.0.1:3001
[mock-fast] admin API on http://127.0.0.1:3110
[mock-fast] DSL: /abs/path/mock-fast.json
```

`GET http://127.0.0.1:3001/health` → `{"ok":true}`.

## Defaults

| Concepto | Default |
|---|---|
| Archivo del DSL | busca en `cwd`: `mock-fast.json`, `mocks.json`, `mock.json` |
| Puerto HTTP | `3001` |
| Host HTTP | `127.0.0.1` |
| CORS | abierto |
| Admin API | `http://127.0.0.1:3110` (provisto por mocks-server) |
| Hot reload | activo (el servidor se entera cuando editás el JSON) |
| Header de auth | `Authorization` con patrón `^Bearer [A-Za-z0-9._-]+$` |

Para tocar cualquiera, va en el JSON:

```json
{
  "server": { "port": 4000, "cors": false },
  "auth": { "headerName": "X-Token", "pattern": "^sk-.+" },
  "routes": [ ... ]
}
```

Flags CLI solo para overrides puntuales:

```bash
mock-fast start --file ./fixtures/mock.json --port 4000 --no-watch
```

## DSL

Cada nodo bajo `routes` puede ser una ruta, un grupo, o ambas cosas.

### Ruta plana

```json
{
  "id": "users-list",
  "method": "get",
  "url": "/api/users",
  "response": { "status": 200, "body": { "users": [] } }
}
```

### Rutas anidadas

La `url` de cada nodo se **concatena** con la del padre. Las hijas heredan `headers` y `extensions` por defecto. Pueden sobrescribir.

```json
{
  "url": "/api/protegida",
  "extensions": { "requireAuth": true },
  "response": { "status": 200, "body": { "data": "raíz" } },
  "routes": [
    {
      "id": "usuarios-list",
      "url": "/usuarios",
      "response": { "status": 200, "body": { "users": ["a", "b"] } }
    },
    {
      "id": "usuarios-byId",
      "url": "/usuarios/:id",
      "response": { "status": 200, "body": { "id": "{{params.id}}" } }
    }
  ]
}
```

URLs finales: `/api/protegida`, `/api/protegida/usuarios`, `/api/protegida/usuarios/:id`. Las tres requieren `Authorization: Bearer ...`.

### Grupos puros (namespace)

Un nodo sin `response` solo agrupa — no registra endpoint. Útil para reutilizar herencia:

```json
{
  "url": "/api",
  "routes": [
    { "id": "login", "url": "/login", "method": "post", "response": { ... } },
    { "id": "logout", "url": "/logout", "method": "post", "response": { ... } }
  ]
}
```

### Reglas de herencia

| Campo | Hereda | Cómo se combina |
|---|---|---|
| `url` | sí | concatenación con `/` |
| `extensions` | sí | merge shallow (la hija sobrescribe por clave) |
| `headers` | sí | merge (la hija gana en colisión) |
| `method` | no | cada ruta define la suya (default `get`) |
| `response` / `responses` | no | sin ninguno = grupo puro, no registra endpoint |

## Respuestas condicionales

Una ruta puede declarar **una** `response` (caso normal) o un array `responses[]` con reglas para elegir cuál servir. Reglas, en orden:

1. Se recorre `responses[]` de arriba a abajo.
2. Se devuelve la **primera** cuyo `when` coincida con el request.
3. Una response **sin** `when` matchea siempre — usala como fallback al final.
4. Si todas tienen `when` y ninguna matchea, mock-fast responde **404** con `{ "error": "No response matched", "route": "...", "method": "...", "url": "..." }`.

Las claves de `when` siguen las mismas variables que el templating: `body.X`, `query.X`, `headers.X`, `params.X`, `token.X`. Soportan dotted-paths arbitrarios (`body.user.address.city`, `body.items.0.id`).

Comparación: **igualdad con coerción a string**. `body.dni: 12345673` (número en el request) matchea contra `"12345673"` (string en la regla). Si el valor del request es un array, matchea si **algún** elemento es igual al esperado (útil para `tags`, `roles`, etc.). `null` en la regla matchea valores `null` **o** ausentes.

Entre claves de un mismo `when` el operador es **AND implícito**. Para OR, declarálo como dos responses separadas.

`response` (singular) y `responses` (array) **no pueden coexistir** en el mismo nodo — el schema lo rechaza.

```json
{
  "id": "verify",
  "url": "/identity/verify",
  "method": "post",
  "responses": [
    {
      "when": { "body.dni": "12345673" },
      "status": 200,
      "body": { "kind": "success", "name": "Renato" }
    },
    {
      "when": { "body.dni": "12345674" },
      "status": 200,
      "body": { "kind": "success", "name": "Juan" }
    },
    {
      "when": { "body.dni": "00000000" },
      "status": 422,
      "body": { "kind": "invalid", "reason": "blacklisted" }
    },
    {
      "status": 200,
      "body": { "kind": "failure", "dni": "{{body.dni}}" }
    }
  ]
}
```

> **Headers son case-insensitive**: Express normaliza a minúsculas, usá `headers.x-api-key`, no `headers.X-Api-Key`.
>
> **Sin templating en `when`**: los valores de matching son literales. El templating sigue corriendo solo sobre `body` y `headers` de la response elegida.
>
> **Operadores (`gt`, `regex`, `in`, ...) no están en v1**. La forma del DSL (`when: { "path": valor }`) está estable; los operadores llegarán como valores tipo objeto (`{ "body.amount": { "gt": 100 } }`) sin romper esta sintaxis.

## Extensiones

Cada extensión se activa al aparecer en `extensions` de una ruta (o de un padre, vía herencia). Corren en este orden:

1. `requireAuth`
2. `rateLimit`
3. `errorRate`
4. `delayRange`

Cualquier extensión que cortocircuita (devuelve 401, 429, 500) no ejecuta las siguientes ni la respuesta normal.

### `requireAuth: boolean`

Verifica que el header de autenticación (`Authorization` por defecto) coincide con `auth.pattern`. Si no, **401**.

```json
"extensions": { "requireAuth": true }
```

Para apagarla en una hija que heredó `true`:

```json
"extensions": { "requireAuth": false }
```

### `errorRate: number` (entre 0 y 1)

Lanza un dado por request. Con probabilidad `errorRate`, responde **500** sin llegar al body normal.

```json
"extensions": { "errorRate": 0.10 }
```

10% de fallos. Útil para probar reintentos del cliente.

### `delayRange: [min, max]`

Retraso aleatorio en milisegundos antes de responder.

```json
"extensions": { "delayRange": [200, 1500] }
```

Cada request espera un valor uniforme en `[min, max]`. Combinable con todo.

### `rateLimit`

Cuenta peticiones por identificador y corta al pasarse. Cubre dos casos con la misma forma: límite uniforme y override por usuario.

```json
"extensions": {
  "rateLimit": {
    "identifier": "{{token.sub}}",
    "window": "1m",
    "max": 100,
    "perUser": {
      "user-vip": 1000,
      "user-locked": 0
    },
    "onLimit": {
      "status": 429,
      "body": { "error": "Too many requests" }
    }
  }
}
```

| Campo | Default | Acepta |
|---|---|---|
| `identifier` | IP del cliente (`req.ip`) | expresión Handlebars: `{{body.x}}`, `{{headers.x}}`, `{{token.sub}}` |
| `window` | `"1m"` | `"1m"`, `"5m"`, `"1h"`, `"session"`, `"on-success"` |
| `max` | requerido | número de peticiones permitidas en la ventana |
| `perUser` | `{}` | mapa `identifier → max` (override del default) |
| `onLimit` | `{ status: 429 }` | response completo cuando se supera |

**Ventanas explicadas:**

- `"1m"`, `"5m"`, `"1h"`: ventana deslizante por tiempo.
- `"session"`: nunca expira hasta que se reinicia el servidor.
- `"on-success"`: el contador se resetea cuando esta misma ruta devuelve `2xx`. Sirve para simular **lockout de login**: tras N intentos fallidos, bloqueado; cuando finalmente pega uno, se libera.

## Templating

Toda string en `response.body`, `response.headers` y `headers` pasa por Handlebars antes de salir. Variables disponibles:

| Variable | Origen |
|---|---|
| `{{params.X}}` | path params (de `/users/:id`) |
| `{{query.X}}` | querystring |
| `{{body.X}}` | request body parseado |
| `{{headers.X}}` | request headers (lowercase) |
| `{{token.X}}` | payload del JWT en el header de auth, decodificado sin verificar |

Helpers:

- `{{faker 'category.method' arg1 arg2}}` — cualquier método de [@faker-js/faker](https://fakerjs.dev). Ej: `{{faker 'person.firstName'}}`, `{{faker 'number.int' min=1 max=100}}`.
- `{{randomInt min max}}` — entero aleatorio en rango.
- `{{uuid}}` — UUID v4.
- `{{now}}` — timestamp ISO.

Ejemplos:

```json
"response": {
  "body": {
    "id": "{{params.id}}",
    "name": "{{faker 'person.fullName'}}",
    "email": "{{faker 'internet.email'}}",
    "tokenSub": "{{token.sub}}",
    "createdAt": "{{now}}"
  }
}
```

### Decodificación del JWT

Si la ruta tiene `requireAuth` y el header trae `Bearer <jwt>`, mock-fast decodifica el payload (base64url, **sin verificar firma** — es un mock) y lo expone en `{{token.*}}`. Útil para personalizar respuestas por usuario sin pedirle al cliente que mande otro header.

## Uso programático

```ts
import { createMockFast } from "mock-fast";

const server = await createMockFast({
  file: "./fixtures/mock.json",
  port: 3001,
  silent: true,
});

await server.start();
// ... tests ...
await server.stop();
```

API:

```ts
interface MockFastInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;       // re-lee el DSL y aplica
  url(): string;                 // http://host:port
  adminUrl(): string;            // http://host:adminPort
}
```

## Hot reload

Por defecto, mock-fast escucha cambios en el archivo del DSL. Cuando lo guardás, recarga rutas/colecciones sin reiniciar el proceso ni cerrar el puerto. Los contadores de `rateLimit` se resetean al recargar — es el comportamiento natural en dev.

Para apagarlo: `--no-watch` o `{ watch: false }` en la API programática.

## Admin API

Heredada de mocks-server, en `http://127.0.0.1:3110` por defecto. Endpoints útiles:

- `GET /api/mock/routes` — lista de rutas.
- `GET /api/mock/collections` — colecciones.
- Swagger UI en `/docs`.

## Ejemplo completo

```json
{
  "auth": {
    "headerName": "Authorization",
    "pattern": "^Bearer [A-Za-z0-9._-]+$"
  },
  "routes": [
    {
      "id": "health",
      "url": "/health",
      "response": { "status": 200, "body": { "ok": true, "ts": "{{now}}" } }
    },
    {
      "url": "/api",
      "routes": [
        {
          "id": "login",
          "url": "/login",
          "method": "post",
          "extensions": {
            "rateLimit": {
              "identifier": "{{body.username}}",
              "window": "on-success",
              "max": 3,
              "onLimit": { "status": 423, "body": { "error": "locked" } }
            }
          },
          "response": {
            "status": 200,
            "body": {
              "token": "Bearer mock.{{uuid}}",
              "user": "{{body.username}}"
            }
          }
        },
        {
          "url": "/protegida",
          "extensions": {
            "requireAuth": true,
            "errorRate": 0.10,
            "delayRange": [100, 500]
          },
          "response": { "status": 200, "body": { "data": "root" } },
          "routes": [
            {
              "id": "users-list",
              "url": "/usuarios",
              "response": {
                "status": 200,
                "body": {
                  "users": [
                    { "id": 1, "name": "{{faker 'person.firstName'}}" }
                  ]
                }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

## Roadmap

Próximas extensiones planeadas (la arquitectura las admite con un archivo nuevo en `src/extensions/`):

- **Variants / scenarios**: cambiar respuestas en bloque vía admin API.
- **Operadores de matching** en `when`: `{ "body.amount": { "gt": 100 } }`, `regex`, `in`, etc. — el shorthand actual (igualdad directa) sigue funcionando.
- **CRUD automático**: declarar `"crud": true` y obtener GET / POST / PUT / DELETE sobre una colección en memoria.
- **Proxy fallback**: rutas no definidas pasan a un backend real.
- **Request schema validation**: 400 si el body no encaja en un schema JSON.
- **Rate limit avanzado**: distribuciones de ventana, métricas.

## Licencia

MIT
