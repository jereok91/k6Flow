# UI: tipografía e íconos

Convenciones de la interfaz. `apps/web/lib/ui/icon-conventions.test.ts` las verifica en CI: si
agregás un ícono que las rompe, el test falla.

## Tipografía

Fuentes cargadas en `apps/web/app/layout.tsx` desde Google Fonts (no se bundlean):

| Rol | Familia | Dónde se usa |
|---|---|---|
| Texto | `Geist` (`--font-sans`) | todo el texto de la app |
| Código | `JetBrains Mono` (`--font-mono`) | URLs, métodos HTTP, identificadores |

La escala vive en `apps/web/app/globals.css` (`@theme`). **Usá los tokens, nunca `text-[13px]`
sueltos** para texto:

| Token | Tamaño | Uso |
|---|---|---|
| `text-label-code-sm` | 11px | etiquetas en mayúsculas, metadatos densos |
| `text-label-code-md` | 12px | etiquetas de tabla, badges monoespaciados |
| `text-label-code-lg` | 13px | etiquetas con más peso |
| `text-body-sm` | 12px | texto secundario |
| `text-body-md` | 13px | texto por defecto |
| `text-body-lg` | 15px | texto destacado |
| `text-headline-sm` | 18px | títulos de tarjeta y sección |
| `text-headline-md` | 22px | títulos de página secundarios |
| `text-headline-lg` | 28px | título de página |
| `text-display` | 40px | portada |

Reglas:

- Colores de texto siempre por token (`text-on-surface`, `text-on-surface-variant`, `text-error`…),
  no hexadecimales sueltos.
- Nada de `style={{ fontSize }}`: si falta un tamaño, agregalo a la escala.

## Íconos

Familia única: **Material Symbols Outlined** (`material-symbols-outlined`), cargada en el layout.
Nunca mezclar otra familia ni pegar SVG a mano.

### Tamaños

La escala permitida es cerrada; el test rechaza cualquier otro valor:

| Clase | px | Uso |
|---|---|---|
| `text-[12px]` | 12 | marcas dentro de controles chicos (checkbox, chip) |
| `text-[16px]` | 16 | inline en texto y filas densas |
| `text-[18px]` | 18 | botones y filas de tabla (el más común) |
| `text-[20px]` | 20 | navegación lateral |
| `text-[24px]` | 24 | encabezados y acciones destacadas |
| `text-[32px]` | 32 | estado de una tarjeta |
| `text-[40px]` | 40 | estado vacío / resultado |
| `text-[48px]` | 48 | héroe de página de error o bloqueo |

### Accesibilidad

- **Decorativo** (el texto de al lado ya dice qué es): `aria-hidden="true"`.
- **Portador de significado** (estado, favorito): `role="img"` + `aria-label="…"`, sin
  `aria-hidden`.
- El ícono nunca es el único contenido de un `<button>` sin `aria-label`.

```tsx
// decorativo, junto a texto
<span className="material-symbols-outlined text-[18px]" aria-hidden="true">save</span>
<span>Guardar</span>

// con significado propio
<span className="material-symbols-outlined text-[24px] text-amber-400" role="img" aria-label="Favorito">star</span>
```

### Nombres

El nombre debe existir en el catálogo de Material Symbols (se renderiza como ligadura). Nunca
lo armes dinámicamente con texto libre: si viene de una constante, esa constante se revisa contra
el catálogo.
