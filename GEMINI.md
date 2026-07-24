# Contexto del Proyecto: UnityAntigravityIDE (`GEMINI.md`)

Este documento sirve como **guía de contexto, arquitectura e instrucciones de trabajo** para asistentes IA (Gemini / Antigravity Agent) y desarrolladores que vayan a iniciar cualquier tarea en este repositorio.

---

## 📌 1. Propósito y Visión del Proyecto

**UnityAntigravityIDE** (`com.canoide.antigravity.ide`) es una integración completa y de alto rendimiento entre el **Unity Editor** y **Antigravity IDE** (y otros forks de VS Code).

### ¿Por qué existe este proyecto?
Las extensiones oficiales de Microsoft (C# Extension, C# Dev Kit y Unity Extension) tienen licencias exclusivas para el cliente oficial de Visual Studio Code y no funcionan en IDEs alternativos o forks abiertos.
Este proyecto soluciona esa limitación combinando:
1. **Un Paquete UPM para Unity (`Editor/`)**: Generación ultra-rápida de proyectos `.csproj`/`.sln`, filtrando assemblies de solo lectura para reducir la carga de ~155 a ~10-15 archivos `.csproj` (tiempo de carga pasa de ~60s a ~2-5s).
2. **Una Extensión de IDE (`antigravity-unity-extension~/`)**: Integración con **DotRush** (Language Server MIT para C# basado en Roslyn), depurador de Unity, resaltado de sintaxis para ShaderLab, HLSL, USS, UXML, asmdef, y recarga automática del workspace de DotRush cuando Unity regenera proyectos.

---

## 🏗️ 2. Estructura del Repositorio y Componentes

```
UnityAntigravityIDE/
├── Editor/                          # Paquete de Unity (C#) - UPM com.canoide.antigravity.ide
│   ├── AntigravityScriptEditor.cs   # Integración con ScriptEditorManager de Unity y UI de Preferencias
│   ├── ProjectGeneration.cs         # Motor de generación optimizado de .csproj y .sln
│   ├── UnityAnalyzerConfig.cs       # Configuración de analizadores Roslyn (.ruleset / .editorconfig)
│   ├── UnityDebugBridge.cs          # Puente para conexión y depuración con Unity
│   ├── AssetUsagesWindow.cs         # Ventana Editor para búsqueda de referencias en Assets
│   └── Analyzers/                   # Analizadores Roslyn específicos para Unity
├── antigravity-unity-extension~/    # Extensión para Antigravity IDE (TypeScript / VS Code API)
│   ├── src/                         # Código fuente TypeScript (comandos, debugger bridge, watchers)
│   ├── syntaxes/                    # Gramáticas de resaltado (ShaderLab, HLSL, USS, UXML, asmdef)
│   ├── snippets/                    # Snippets C# para Unity (MonoBehaviour, mensajes, etc.)
│   ├── release-extension.py         # Script de automatización de releases y publicación
│   └── package.json                 # Manifest de la extensión VS Code / Antigravity
├── .agents/                         # Reglas y flujos de trabajo automatizados para el agente
│   └── workflows/
│       └── publish.md               # Workflow para compilación, incremento de versión y publicación
├── docs/                            # Documentación técnica detallada
│   └── DOTRUSH_UNITY_INTEGRATION.md # Arquitectura del flujo DotRush ↔ Unity
├── .githooks/                       # Git Hooks locales
│   └── pre-commit                   # Hook bash para auto-incrementar versión patch en commits
└── package.json                     # Manifest del paquete Unity (UPM com.canoide.antigravity.ide)
```

> ⚠️ **Nota sobre carpetas finalizadas en `~`**: Las carpetas como `antigravity-unity-extension~` usan la tilde `~` porque Unity las ignora automáticamente durante la compilación del proyecto de Unity. Son de uso exclusivo para desarrollo y entorno IDE.

---

## ⚙️ 3. Flujos de Trabajo y Comandos Clave

### A. Desarrollo de la Extensión IDE (`antigravity-unity-extension~`)
- **Instalar dependencias**:
  ```bash
  cd antigravity-unity-extension~
  npm install
  ```
- **Compilar código TypeScript**:
  ```bash
  npm run compile
  ```
- **Empaquetar archivo VSIX**:
  ```bash
  npm run package
  ```

### B. Publicación y Release Automático
Para realizar un release completo (incrementar versión, empaquetar `.vsix`, publicar en Open VSX y crear Release en GitHub):
```bash
python antigravity-unity-extension~/release-extension.py -m "feat/fix: descripción del cambio"
```
*(Ver detalles en [.agents/workflows/publish.md](file:///d:/Projects/Git/UnityAntigravityIDE/.agents/workflows/publish.md))*

### C. Versionado Automático en Commits
El proyecto usa `.githooks/pre-commit` para auto-incrementar la versión patch en cada commit. Asegurarse de tener configurados los hooks si se trabaja con git local:
```bash
git config core.hooksPath .githooks
```

---

## 🚀 4. Guía para Iniciar una Tarea (Paso a Paso)

Cuando recibas un requerimiento o vayas a implementar un cambio, sigue este checklist:

### Paso 1: Identificar el Componente Objetivo
| Si la tarea requiere... | Ubicación del Código | Lenguaje / Tecnologías |
| :--- | :--- | :--- |
| Cambios en la generación de `.csproj`/`.sln`, integración con Unity, preferencias en Editor | [`Editor/`](file:///d:/Projects/Git/UnityAntigravityIDE/Editor) | C# (Unity Editor Scripting) |
| Cambios en resaltado de código, snippets, comandos IDE, watcher de proyectos o conexión DotRush | [`antigravity-unity-extension~/`](file:///d:/Projects/Git/UnityAntigravityIDE/antigravity-unity-extension~) | TypeScript (VS Code Extension API) |
| Documentación técnica o arquitectura | [`docs/`](file:///d:/Projects/Git/UnityAntigravityIDE/docs) | Markdown |
| Flujos de trabajo y automatización de release | [`release-extension.py`](file:///d:/Projects/Git/UnityAntigravityIDE/antigravity-unity-extension~/release-extension.py) / [`.agents/`](file:///d:/Projects/Git/UnityAntigravityIDE/.agents) | Python / Markdown |

### Paso 2: Consultar Documentación Específica
- Si vas a tocar el sistema de IntelliSense C# o la sincronización entre `.csproj` y DotRush, lee primero [`docs/DOTRUSH_UNITY_INTEGRATION.md`](file:///d:/Projects/Git/UnityAntigravityIDE/docs/DOTRUSH_UNITY_INTEGRATION.md).
- Si vas a publicar o realizar un bump de versión, consulta [`.agents/workflows/publish.md`](file:///d:/Projects/Git/UnityAntigravityIDE/.agents/workflows/publish.md).

### Paso 3: Principios de Desarrollo y Buenas Prácticas
1. **Rendimiento de Generación de Proyectos**: No alterar el comportamiento de `ProjectGeneration.cs` de incluir solo assemblies de proyectos editables (salvo que sea configurable). Omitir las carpetas internas de paquetes de solo lectura es clave para mantener el tiempo de carga en 2-5 segundos.
2. **Compatibilidad Roslyn / DotRush**: Las referencias en `.csproj` deben mantener tanto `<Reference>` con `<HintPath>` como `<ProjectReference>` para asegurar navegación e IntelliSense.
3. **No Dependencias de Microsoft Closed Extensions**: Toda la inteligencia C# depende de `DotRush` (`nromanov.dotrush`). No introducir llamadas o configuraciones que asuman el uso del C# Dev Kit de Microsoft.
4. **Verificación de Cambios**:
   - En TypeScript: ejecutar `npm run compile` dentro de `antigravity-unity-extension~` y comprobar que no hay errores de linter/tipos.
   - En C# Unity: asegurar que el paquete compila sin errores para no degradar la experiencia dentro del Unity Editor.

---

## 📄 5. Archivos de Referencia Rápida

- [**package.json (Paquete Unity)**](file:///d:/Projects/Git/UnityAntigravityIDE/package.json): Información de versión UPM (`com.canoide.antigravity.ide`).
- [**ProjectGeneration.cs**](file:///d:/Projects/Git/UnityAntigravityIDE/Editor/ProjectGeneration.cs): Motor principal de generación de solución y proyectos `.csproj`.
- [**AntigravityScriptEditor.cs**](file:///d:/Projects/Git/UnityAntigravityIDE/Editor/AntigravityScriptEditor.cs): Registro de Antigravity IDE como External Script Editor en Unity.
- [**antigravity-unity-extension~/package.json**](file:///d:/Projects/Git/UnityAntigravityIDE/antigravity-unity-extension~/package.json): Manifest de la extensión de Antigravity IDE (comandos, lenguajes, contribuciones).
- [**DOTRUSH_UNITY_INTEGRATION.md**](file:///d:/Projects/Git/UnityAntigravityIDE/docs/DOTRUSH_UNITY_INTEGRATION.md): Diagrama y detalle del canal de comunicación entre Unity, DotRush y Antigravity.
