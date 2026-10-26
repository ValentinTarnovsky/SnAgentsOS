# SnAgentsOS: documentos vigentes

- [CONTRATOS.md](CONTRATOS.md): fuente unica de verdad para mensajes WS, canales IPC, claves de config con su version de schema y atajos de teclado. Si otro documento lo contradice, gana este archivo.
- [FEATURES.md](FEATURES.md): mapa de capacidades, una fila por capacidad con sus superficies, archivos y la suite que la verifica (lo valida `scripts/test-docs.cjs`).
- [epics/E9.md](epics/E9.md): Workspace: Notas, Archivos y estado de agentes (app 2.2.0).
- [epics/E10.md](epics/E10.md): Cimientos y Equipos de agentes (app 2.7.0).

El PRD, el PLAN y los epics E0 a E8 (rebrand a SnAgentsOS y el roadmap inspirado en [stablyai/orca](https://github.com/stablyai/orca), MIT) se retiraron del arbol una vez publicados en 2.0.0, 2.1.0 y 2.2.0. Siguen en el historial de git: `git show 9925b55:docs/snagentsos/PRD.md` (idem `PLAN.md` y `epics/E<n>.md`).
