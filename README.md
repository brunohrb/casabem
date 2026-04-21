# casa BEM

Dashboard e automação residencial integrando Tuya, Alexa e Supabase.

## O que tem aqui

```
.
├── index.html                   # Dashboard (SPA único, vanilla JS)
├── logo.png
│
├── supabase/                    # Backend (banco + Edge Functions + cron)
│   ├── config.toml              # Config do Supabase CLI
│   ├── schema-baseline.sql      # Schema inicial (devices, commands_log, reminders)
│   ├── migrations/
│   │   ├── 20260421_000000_energy_tracking.sql   # Energia + timers + triggers
│   │   └── 20260421_000100_cron_jobs.sql         # pg_cron (tuya-sync / timer-worker)
│   └── functions/
│       ├── tuya-control/        # Liga/desliga/status no Tuya Cloud
│       ├── tuya-sync/           # Polling 20 s — detecta interruptor manual
│       └── timer-worker/        # Executa timers persistidos (auto-off)
│
├── alexa-skill/                 # Custom Alexa Skill (Node.js)
│   ├── index.js
│   ├── interaction-model-pt-BR.json
│   └── package.json
│
└── docs/
    ├── ARQUITETURA.md           # Como as peças se encaixam
    ├── DEPLOY.md                # Passo a passo de deploy
    ├── ALEXA-SKILL.md           # Tuya nativa vs Custom Skill
    └── COMO-CONFIGURAR-LEGACY.html   # Guia original (referência)
```

## Recursos

- **Dashboard unificado** (web) — lista + mapa, voz "BEM" pt-BR, lembretes.
- **Detecção do interruptor físico** — o polling `tuya-sync` descobre
  quando alguém apertou o interruptor na parede e reflete no app em
  até 20 s.
- **Auto-off persistido** — agenda "desligar em X min" pelo card do
  device ou por regras de automação. Roda no servidor, sobrevive ao
  fechamento do app.
- **Indicadores de uso** — tempo ligado ao vivo por aparelho +
  acumulado por histórico de sessões.
- **Alexa** — Tuya Smart Home Skill nativa (controle direto) e
  Custom Skill "casa BEM" (comandos ricos em português).

Para colocar no ar tudo o que foi reorganizado nessa branch, siga
[`docs/DEPLOY.md`](docs/DEPLOY.md).
