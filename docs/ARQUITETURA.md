# 🏗️ Arquitetura — casa BEM

Documento rápido pra entender o "fluxo das coisas" depois da
reorganização. Mantenha na pasta `docs/` — serve de referência
quando voltar ao projeto daqui uns meses.

```
  ┌──────────────┐  ┌──────────────┐  ┌────────────┐
  │ Interruptor  │  │ App Alexa    │  │ Dashboard  │
  │  físico      │  │ (Smart Home) │  │ (this app) │
  └──────┬───────┘  └──────┬───────┘  └──────┬─────┘
         │                  │                 │
         │  estado real     │  comando        │  update
         ▼                  ▼                 ▼
       ┌─────────────────────────────────────────────┐
       │            Tuya Cloud IoT                   │
       └─────────────────────────────────────────────┘
         ▲              ▲                   ▲
         │              │                   │
 poll (20s)        push Tuya→Alexa          fetch (tuya-control)
         │              │                   │
       ┌────────────────────────────────────┴─────┐
       │ Supabase                                 │
       │ ─────────                                │
       │  • devices  (state + on_since + ...)     │
       │  • device_sessions  (histórico)          │
       │  • pending_timers  (auto-off)            │
       │  • commands_log  (auditoria)             │
       │  • reminders                             │
       │                                          │
       │ Edge Functions                           │
       │  • tuya-control   (ligar/desligar/status)│
       │  • tuya-sync      (polling 20s)          │
       │  • timer-worker   (executa timers 10s)   │
       │                                          │
       │ pg_cron                                  │
       │  • casabem_tuya_sync    a cada 20s       │
       │  • casabem_timer_worker a cada 10s       │
       │                                          │
       │ Triggers (fonte única da verdade)        │
       │  • trg_devices_on_since                  │
       │  • trg_devices_sessions                  │
       └─────────────────┬────────────────────────┘
                         │
                         │ Realtime (WebSocket)
                         ▼
            ┌──────────────────────────┐
            │ Dashboard (navegador)    │
            │ mostra estado + timers + │
            │ indicadores de uso       │
            └──────────────────────────┘
```

## Quem gera o quê

| Evento                          | Ator                       | Como o sistema sabe                       |
|---------------------------------|----------------------------|-------------------------------------------|
| Liga pelo **interruptor físico**| Mundo real → Tuya Cloud    | `tuya-sync` detecta a cada 20 s. Marca `last_source='manual'`. Dashboard recebe via Realtime e mostra toast 🔘. |
| Liga pelo **app Alexa nativo**  | Alexa Smart Home → Tuya    | Mesmo caminho do item acima (o Tuya é a fonte da verdade). |
| Liga pelo **Alexa Skill (BEM)** | Skill → Supabase REST      | Alexa Skill escreve `status=true, last_source='alexa'`. Trigger abre sessão, Realtime avisa. Depois `tuya-sync` confirma fisicamente. |
| Liga pelo **dashboard**         | Browser → Supabase + tuya-control | Sync de ida (comando Tuya) e de volta (realtime echo). `last_source='app'`. |
| **Regra** "após N min desligar" | `evaluateRules()` + `pending_timers` | O frontend persiste a linha e também arma `setTimeout`. Se o app fechar, o `timer-worker` executa no banco e manda pro Tuya. `last_source='rule'`. |
| Timer manual "desligar em X"    | Modal ⏲️ Desligar em… + `pending_timers` | Igual ao item acima mas sem vincular regra. `last_source='manual_timer'`. |

## Por que triggers no banco?

Antes havia duplicação de lógica: o dashboard calculava `on_since` e
inseria em `device_sessions`, a Alexa Skill ficava com estado
"furado" (só escrevia `status`), e o `timer-worker` precisava fazer
tudo de novo.

Agora todos escrevem apenas `{status, last_source, last_changed}` na
tabela `devices`. Os **triggers** (`devices_manage_on_since` e
`devices_log_sessions`) se viram sozinhos. Um único ponto de
manutenção, impossível de ficar fora de sincronia.

## Regras de segurança (RLS)

Seguimos o padrão do schema original: todas as tabelas têm RLS
ligado com política aberta (`USING (true) WITH CHECK (true)`). É
uso pessoal com a anon key. Se um dia virar multi-usuário, trocar
essas policies por algo baseado em `auth.uid()`.

## Observabilidade

- `commands_log` ganhou fontes mais ricas (`manual`, `rule`,
  `manual_timer`, `tuya-sync`) — dá pra filtrar depois.
- `pending_timers.error` guarda erros de execução.
- `devices.last_tuya_sync_at` diz quando o polling confirmou o
  estado físico pela última vez — útil pra detectar se a Edge
  Function parou.

## Arquivos pra se orientar

```
.
├── index.html                               # Dashboard principal
├── casa_inteligente/                        # Baseline funcional (referência)
│   ├── supabase-schema.sql                  # Schema inicial
│   ├── supabase-edge-function/tuya-control/ # ⟶ cópia em supabase/functions/
│   └── alexa-skill/                         # Skill Alexa v1
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 20260421_000000_energy_tracking.sql
│   │   └── 20260421_000100_cron_jobs.sql
│   └── functions/
│       ├── tuya-control/   # (espelho de casa_inteligente/…)
│       ├── tuya-sync/      # polling novo
│       └── timer-worker/   # executor de auto-off
└── docs/
    ├── ARQUITETURA.md      # (este arquivo)
    ├── DEPLOY.md
    └── ALEXA-SKILL.md
```
