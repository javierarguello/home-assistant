# Prompt: HAL 9000 Home Assistant Kiosk

## Stack
- **Framework**: TanStack Start (v1) con Vite + SSR
- **Language**: TypeScript + React 19
- **Styling**: Tailwind CSS v4 con variables CSS personalizadas
- **Fonts**: JetBrains Mono / Orbitron (monospace)

## Descripción General
Crea un kiosk de Home Assistant con estética de **2001: Una odisea del espacio** (HAL 9000). El diseño es oscuro, espacial, con un ojo rojo central que reacciona al audio. El sistema escucha continuamente con wake word implícito (modo siempre activo), y cuando HAL habla, el ojo se anima hacia arriba/reduce tamaño y el contenido aparece debajo. Todo el texto es en español (`es-ES`).

---

## Paleta de Colores (CSS Variables en `src/styles.css`)

```css
:root {
  --background: oklch(0.06 0.01 240);
  --foreground: oklch(0.95 0.02 30);
  --hal: oklch(0.62 0.26 25);         /* rojo HAL */
  --hal-glow: oklch(0.72 0.28 30);    /* rojo brillante */
  --hal-dim: oklch(0.35 0.18 25);     /* rojo oscuro */
  --grid: oklch(0.18 0.04 240);
}
```

Background del body: `radial-gradient(ellipse at center, oklch(0.09 0.02 250) 0%, oklch(0.03 0.01 240) 70%, #000 100%)`

---

## Componentes

### 1. Starfield (`src/components/Starfield.tsx`)
Canvas fijo a pantalla completa (`fixed inset-0 -z-10 opacity-60`). Simula estrellas en 3D (240 estrellas) que se mueven hacia el espectador. Cada frame pinta un rectángulo negro semi-transparente (`rgba(0,0,0,0.35)`) sobre el canvas anterior para crear el efecto de rastro. Las estrellas son pequeños cuadrados blancos-azulados (`rgba(220,230,255, alpha)`). Se reciclan cuando `z <= 0`.

### 2. HalEye (`src/components/HalEye.tsx`)
Ojo circular de 16rem (256px) con efectos de anillo orbital:
- **Anillo exterior**: 28rem, borde sutil, rota con `animation: orbit 40s linear infinite`. Tiene 4 marcas de cruceta (barras horizontales/verticales) en los 4 puntos cardinales, color `--hal/70`.
- **Anillo medio**: 22rem, rota en reversa `orbit 24s`.
- **Bisel**: círculo negro con ring gris oscuro y shadow gigante.
- **El ojo**: círculo con gradiente radial que va de blanco cálido en el centro → rojo brillante → rojo oscuro → negro en los bordes.
- **Pupila**: círculo negro en el centro que escala según el nivel de audio (`scale = 1 + level * 0.35`). Tiene un pequeño brillo rojizo en su centro con opacidad ligada al nivel.
- **Highlight**: óvalo blanco translúcido arriba a la izquierda (`blur-md`) para efecto de lente.
- **Modo label**: texto debajo del ojo indicando "● escuchando", "● transmitiendo", "○ en espera".

**Clases CSS de animación**:
- `.hal-idle` → `hal-pulse-idle` (4s, sombras tenues rojas pulsantes)
- `.hal-listen` → `hal-pulse-listen` (1.2s, sombras más intensas + leve scale)
- `.hal-speak` → `hal-speak` (0.6s, sombras muy intensas y cambiantes)

### 3. Kiosk Principal (`src/routes/index.tsx`)
Layout de 3 columnas en desktop (`lg:grid-cols-[1fr_auto_1fr]`), 1 columna en móvil.

**Capas de fondo**:
1. `<Starfield />`
2. `.grid-bg` (líneas de cuadrícula tenues con máscara radial)
3. `.scanlines` (líneas horizontales repetidas simulando CRT)

**Header**: HUD estilo terminal — "HAL · 9000 · Home Assistant Interface" a la izquierda, indicadores "MIC · LIVE/OFF", "SYS · ONLINE", timestamp UTC a la derecha. Fuente monospace 10px, tracking amplio, color `--hal/70`.

**Panel Izquierdo — Entrada de audio**:
- Borde `border-hal/20`, fondo `bg-black/60`, `backdrop-blur-sm`
- Label "▸ entrada · audio" con indicador REC
- Muestra el texto transcrito (`heard`) con animación `float-text`
- Interim results en color `--hal/60`
- Placeholder: "Escuchando…" / "Esperando voz humana…"
- Barra de nivel de audio en la parte inferior (div que crece según `level`)

**Panel Central — El ojo + salida hablada**:
- El ojo `<HalEye>` se envuelve en un `<div>` cuyo `transform` cambia según `isSpeaking`:
  - Hablando: `translateY(-40px) scale(0.45)`, opacity 0.85
  - No hablando: `translateY(40px) scale(1)`, opacity 1
  - Transición suave: `duration-700 ease-out`
- **Panel de salida** (debajo del ojo, aparece solo cuando `isSpeaking`):
  - `maxHeight` animado: 420px cuando habla, 0px cuando no
  - Fondo negro translúcido con borde `--hal/40` y shadow roja intensa (`shadow-[0_0_60px_rgba(255,80,60,0.25)]`)
  - Label "▸ hal · transmitiendo" con punto LIVE pulsante
  - Texto en monospace `text-2xl` color `--hal` con efecto de tipeo letra por letra
  - Cursor parpadeante (barra vertical roja, animación `caret-blink`)
- **Botón de control** debajo:
  - Si no escucha: "◉ activar escucha continua" — borde rojo, fondo rojo/20, shadow roja
  - Si escucha: "■ silenciar mic" — borde rojo/60, fondo rojo/10
- Mensaje de fallback si SpeechRecognition no está soportado

**Panel Derecho — Log de salida**:
- Muestra el último texto completo que HAL dijo (`fullSpoken`)
- Label "▸ salida · hal-9000" con indicador TX
- Info inferior: "freq · 432hz", "canal · 09", conteo de voces de síntesis

**Footer fijo — Input de texto**:
- Fondo negro/80 con blur, borde superior `--hal/20`
- Prefijo "HAL ▸" en rojo
- Input placeholder: "Escribe un mensaje para que HAL lo lea en voz alta…"
- Botón "transmitir" a la derecha
- Cursor parpadeante rojo al final del input

---

## Comportamiento de Voz y Audio

### Estados
- `isListening` (boolean): micrófono activo
- `isSpeaking` (boolean): HAL está hablando
- `mode` (derivado): `"speaking"` si `isSpeaking`, `"listening"` si `isListening`, `"idle"` en otro caso
- `level` (0..1): nivel de audio para animar la pupila

### Ciclo de interacción
1. Usuario presiona "activar escucha continua"
2. Se inicia `SpeechRecognition` (`es-ES`, `continuous: true`, `interimResults: true`)
3. Se inicia `AudioContext` + `AnalyserNode` para visualizar niveles de audio en tiempo real
4. El ojo pasa a modo `listening` (brillo pulsante rápido)
5. Cuando el usuario deja de hablar, `onresult` entrega texto final → se guarda en `heard`
6. `useEffect` detecta `heard` y llama a `speak(heard)`
7. `isSpeaking = true` → ojo sube y se achica, panel de salida aparece debajo
8. `speechSynthesis` lee el texto con voz española (rate 0.92, pitch 0.85)
9. Simultáneamente, texto se tipea letra por letra en el panel central (intervalo adaptado a longitud del texto)
10. Durante la síntesis, `level` se actualiza con valores aleatorios (0.4-0.9) para animar la pupila
11. Al terminar (`onend`): `isSpeaking = false`, ojo vuelve a posición normal
12. **El micrófono se reinicia automáticamente** después de 250ms (`setTimeout`), manteniendo la escucha continua (wake-word style)
13. Para detener completamente: usuario presiona "silenciar mic"

### Escucha continua (wake-word implícito)
- `wantListenRef` (useRef) rastrea si el usuario quiere seguir escuchando
- `onend` del recognizer: si `wantListenRef.current === true`, reinicia `startListening()` después de 250ms
- Si el usuario presiona "silenciar mic", `wantListenRef.current = false` y no se reinicia
- Esto simula un asistente siempre escuchando sin necesidad de decir una palabra de activación

### Tipeo de texto hablado
- Al iniciar `speak()`, se limpia `spoken` y se guarda texto completo en `fullSpoken`
- Intervalo calculado: `stepMs = Math.max(20, Math.min(60, 2400 / Math.max(text.length, 10)))`
- Cada intervalo se añade una letra más a `spoken`
- Cursor parpadeante al final
- Al terminar la síntesis, se muestra el texto completo y se limpia el intervalo

### Audio reactivo
- `startMicAnalyser()`: obtiene stream del micrófono, crea `AudioContext`, conecta `MediaStreamSource` → `AnalyserNode` (fftSize 512)
- Cada frame calcula RMS del time domain data y actualiza `level` (multiplicado por 3, clamp a 1)
- Durante `isSpeaking`, se omite el nivel del micrófono y se usa nivel sintético aleatorio para la animación de la pupila

---

## Animaciones CSS (en `src/styles.css`)

```css
@keyframes hal-pulse-idle {
  0%, 100% { box-shadow: 0 0 60px 10px var(--hal-dim), inset 0 0 40px 5px oklch(0 0 0 / 0.8); }
  50% { box-shadow: 0 0 80px 15px var(--hal), inset 0 0 50px 8px oklch(0 0 0 / 0.7); }
}

@keyframes hal-pulse-listen {
  0%, 100% { box-shadow: 0 0 80px 20px var(--hal), 0 0 140px 40px var(--hal-dim), inset 0 0 30px 5px oklch(0 0 0 / 0.6); transform: scale(1); }
  50% { box-shadow: 0 0 120px 30px var(--hal-glow), 0 0 200px 60px var(--hal), inset 0 0 20px 3px oklch(0 0 0 / 0.4); transform: scale(1.04); }
}

@keyframes hal-speak {
  0%, 100% { box-shadow: 0 0 100px 25px var(--hal-glow), 0 0 180px 50px var(--hal), inset 0 0 25px 4px oklch(0 0 0 / 0.5); }
  25% { box-shadow: 0 0 140px 40px var(--hal-glow), 0 0 220px 70px var(--hal), inset 0 0 15px 2px oklch(0 0 0 / 0.3); }
  50% { box-shadow: 0 0 90px 20px var(--hal), 0 0 160px 45px var(--hal-dim), inset 0 0 30px 6px oklch(0 0 0 / 0.6); }
  75% { box-shadow: 0 0 160px 50px var(--hal-glow), 0 0 240px 80px var(--hal), inset 0 0 10px 2px oklch(0 0 0 / 0.2); }
}

@keyframes scan-line { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
@keyframes caret-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
@keyframes orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes float-text { from { opacity: 0; transform: translateY(8px); filter: blur(4px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
```

---

## Estructura de Archivos

```
src/
├── styles.css           # Variables CSS, keyframes, clases .hal-idle/.hal-listen/.hal-speak, .scanlines, .grid-bg
├── components/
│   ├── HalEye.tsx       # Ojo HAL con anillos orbitales y pupila reactiva
│   └── Starfield.tsx    # Canvas de estrellas en 3D
└── routes/
    └── index.tsx        # Kiosk principal con lógica de voz
```

---

## Detalles de Implementación Importantes

### Web Speech API
- `SpeechRecognition` con fallback a `webkitSpeechRecognition`
- `lang = "es-ES"`
- `continuous: true`, `interimResults: true`
- Si no está soportado, mostrar mensaje de fallback

### Speech Synthesis
- `window.speechSynthesis.getVoices()` para obtener voces disponibles
- Elegir voz española (`es`) o la primera disponible
- `rate: 0.92`, `pitch: 0.85` para tono HAL-like
- Cancelar síntesis anterior antes de hablar (`window.speechSynthesis.cancel()`)

### Cleanup
- Al desmontar: `window.speechSynthesis.cancel()`, `recog.abort()`, detener stream del micrófono, cerrar `AudioContext`, cancelar `requestAnimationFrame`
- En `useEffect` cleanup del componente principal

### Responsive
- Grid de 1 columna en móvil, 3 columnas en desktop (`lg:`)
- Ojo y paneles se adaptan al ancho

---

## Estilo Visual Clave
- Todo en **monospace** (JetBrains Mono / Orbitron)
- Texto en **mayúsculas con tracking amplio** para etiquetas/labels
- Bordes finos y translúcidos (`border-hal/20`, `border-hal/40`)
- Fondos negros semi-transparentes (`bg-black/60`, `bg-black/70`)
- Efectos de glow rojo en sombras y bordes
- No usar colores directamente en componentes — siempre usar las variables CSS semánticas

## Imagen de Referencia
Vista del kiosk con el ojo HAL en el centro, paneles de entrada/salida a los lados, fondo estrellado, y estilo terminal oscuro:

![HAL Kiosk Screenshot](https://storage.googleapis.com/gpt-engineer-file-uploads/3ee8d2df-6469-4c4f-8855-3eec98b9684e/tool-images/767640e4-5b2c-4d14-bbc2-bd2b64d50481.png)
