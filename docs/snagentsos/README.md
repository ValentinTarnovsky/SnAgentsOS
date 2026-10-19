# SnAgentsOS: PRD y plan

Programa de cambios que renombra SnMultiCC a SnAgentsOS e incorpora el roadmap inspirado en el analisis de [stablyai/orca](https://github.com/stablyai/orca) (MIT). Base: `main` `4c521f9` (SnMultiCC 1.14.1). Fecha: 2026-10-18.

> **Como se publico:** todo el programa (v2.1, v2.2, v3.0 y v3.1 del plan) salio junto en una sola release, SnAgentsOS 2.0.0. La version de `package.json` sigue en `2.0.0`; los schemas de config 11 a 14 se mantienen como migraciones secuenciales y los work packages "Release vX" del plan no se ejecutaron por separado.

## Como leerlo

1. [PRD.md](PRD.md): vision, objetivos con metricas, no objetivos, principios, requisitos no funcionales globales, mapa de epics y glosario.
2. [CONTRATOS.md](CONTRATOS.md): fuente unica de verdad para mensajes WS, canales IPC, claves de config con su version de schema y atajos de teclado. Si un epic contradice este archivo, gana este archivo.
3. [PLAN.md](PLAN.md): releases (v2.0.0 rebrand, v2.1, v2.2, v3.0, v3.1), work packages con rama, FR cubiertos, archivos, pruebas y verificacion manual, grafo de dependencias y proceso de release.
4. `epics/`: un PRD por epic con requisitos funcionales numerados (`E<n>-FR-<nn>`), diseno tecnico, criterios de aceptacion, pruebas y riesgos.

| Epic | Documento |
|---|---|
| E0 | [Rebrand a SnAgentsOS (v2.0.0)](epics/E0.md): migracion automatica de SnMultiCC y borrado de lo viejo, sin rollback a 1.x (respaldo `migration-backup-v1.zip` por 30 dias) |
| E1 | [Mobile fundaciones (M1-M5)](epics/E1.md) |
| E2 | [Mobile Home, respuestas y notificaciones (M6-M9 + notifs)](epics/E2.md) |
| E3 | [Mobile como herramienta de trabajo (M10-M14 + Changes mobile)](epics/E3.md) |
| E4 | [Desktop comodidad diaria](epics/E4.md) |
| E5 | [Agentes](epics/E5.md) |
| E6 | [Motor de terminal](epics/E6.md) |
| E7 | [Git](epics/E7.md) |
| E8 | [Automatizacion y CLI](epics/E8.md) |
| E9 | [Workspace: Notas, Archivos y estado de agentes (app 2.2.0)](epics/E9.md) |

## Como se armo

Se analizaron 12 areas de Orca y cada idea paso por un verificador. Despues se escribio un borrador por epic contra el codigo real, un revisor lo comparo con el codigo y se aplicaron sus correcciones. Un critico de consistencia entre epics unifico los contratos (56 ediciones) y un critico de completitud cerro 20 huecos del plan. El resultado es que todos los FR tienen un work package.
