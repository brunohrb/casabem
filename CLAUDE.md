# CLAUDE.md

Contexto para futuras sessões do Claude Code trabalhando neste repositório.

## O que é este projeto

Painel web de casa inteligente (**Casa BEM**) do usuário Bruno. Arquitetura deliberadamente simples:

- **Frontend**: um único `index.html` (~2.400 linhas) com HTML + CSS + JS puro, sem build step. Abre direto no navegador.
- **Backend**: Supabase (Postgres + Realtime + Edge Functions).
- **Integração física**: Tuya Cloud API, via Edge Function `tuya-control`.
- **Voz**: Web Speech API do próprio navegador com wake word "BEM".
- **Alexa**: integra pelo mesmo banco (Alexa grava em `devices` / `commands_log` / `reminders` via outra Edge Function fora deste repo).

Idioma de UI, toasts, commits e conversa com o usuário: **português do Brasil**.

## Layout do repositório

```
casabem/
├── index.html                              # TUDO do frontend. Não quebrar em arquivos.
├── logo.png
├── README.md
├── CLAUDE.md                               # este arquivo
└── supabase/
    ├── functions/tuya-control/index.ts     # Edge Function Deno/TS
    └── migrations/001_ir_and_manual_source.sql
```

## Schema do banco (Supabase)

Tabelas principais (inferidas do frontend, o usuário é quem controla o Supabase):

- `devices`: `id uuid`, `name`, `room`, `type` ('light'|'ac'|'tv'|'vacuum'|'other'), `status bool`, `brightness int`, `temperature int`, `ac_mode text`, `volume int`, `tuya_device_id text`, `tuya_ir_parent_id text`, `last_changed text` ('dashboard'|'alexa'|'manual').
- `commands_log`: `device_id`, `device_name`, `command`, `source` (mesmos valores de `last_changed`), `success`, `created_at`.
- `reminders`: `id`, `title`, `done`, `source`, `created_at`.

Realtime está ligado em `devices`, `commands_log` e `reminders` (vide `subscribeRealtime()`).

## Features já implementadas

- **Dispositivos**: cards por cômodo + mapa da planta + estatísticas.
- **Tipos suportados**: light (brilho), ac (temp + modo), tv (volume), vacuum (limpar/pausar/dock/locate), other. Adicionar novo tipo exige mexer em: `deviceCardHTML`, `deviceIcon`, modal `<option>`, voice parser, card extra controls.
- **Voz** (`handleCommand`): reconhece ligar/desligar/limpar/pausar + cômodos + tipos (luz, ar, aspirador).
- **Regras de automação** (local, `localStorage`):
  - Trigger: device + evento (on/off). Delay: s/min/h. Ação: on/off em qualquer device.
  - Cancela timer se o gatilho for revertido.
  - Dispara por dashboard, voz, Alexa (realtime) e interruptor físico (polling).
  - Código isolado na seção "REGRAS DE AUTOMAÇÃO" do `<script>`.
  - Dedupe de eco (`recentlyFiredTriggers`) evita disparo duplo.
- **Detecção de interruptor físico** (polling Tuya a cada 15s):
  - `syncPhysicalState()` chama a Edge Function com `action:status_all`.
  - Se a function responder "action desconhecida", chama `warnStaleFunction()` → toast vermelho + badge "⚠️ Function desatualizada" + auto-pausa.
  - Ctrl/Cmd + clique no badge do header força sync imediato.
- **Edge Function `tuya-control`**: assinatura HMAC-SHA256, cache de token, suporta:
  - `control` para light/plug (switch_led + bright_value)
  - `control` para vacuum (power_go + mode)
  - `control` para TV (IR key=power)
  - `control` para AC (endpoint `/air-conditioners/command` com power/mode/temp)
  - `status`, `status_all`, `vacuum_dock`, `vacuum_locate`, `list_remotes`

## O que o usuário precisa fazer manualmente (não automatizável)

Estas etapas dependem de credenciais e acesso administrativo do Bruno; o Claude **não consegue** executá-las sozinho:

1. Setar secrets no Supabase: `TUYA_CLIENT_ID`, `TUYA_SECRET`, `TUYA_BASE_URL` (geralmente `https://openapi.tuyaus.com`).
2. Rodar `supabase/migrations/001_ir_and_manual_source.sql` no SQL Editor.
3. `supabase functions deploy tuya-control --project-ref <ref>`.
4. No modal de dispositivo, preencher `tuya_device_id` e (para TV/AC) `tuya_ir_parent_id` apontando ao IR Blaster.
5. Criar as regras de automação no painel (sidebar → Nova Regra).

## Convenções de código

- Toasts (`showToast`) para feedback rápido. Mensagens em português, com emoji.
- Commits descritivos em português, múltiplas linhas. Sem tag `[skip ci]`.
- Branch de trabalho designado pelo runner (ex.: `claude/automation-rules-vacuum-fix-DhwHz`). **Nunca** dar push em `main` sem permissão explícita.
- Nada de build tools (Webpack/Vite). Continuar com HTML puro.
- `localStorage` é aceitável para preferências e regras. Evitar criar novas tabelas sem necessidade clara — o usuário cuida do Supabase manualmente.

## Erros comuns / Troubleshooting rápido

| Sintoma | Causa provável |
|---|---|
| "A regra não dispara ao ligar no dedo" | Edge Function antiga sem `status_all`. Badge do header vai ficar vermelho "⚠️ Function desatualizada" após ~15s. |
| "TV/AC não liga" | Falta `tuya_ir_parent_id` no device, ou os controles não foram aprendidos no app Smart Life. |
| "Aspirador não responde" | Tuya usa DP específico por modelo (`power_go` vs `switch`); se for modelo raro, pode precisar mapear na Edge Function. |
| "Comando de voz ignora o dispositivo" | Verificar se o nome do cômodo bate com o `roomMap` em `handleCommand`. |

## Estilo de resposta esperado

- Responder em português do Brasil, tom descontraído (o usuário usa muito "kkk" e abrevia).
- Explicar **o porquê** quando algo não funciona, não só o "o quê".
- Antes de atribuir bug ao frontend, considerar se é falta de deploy da Edge Function ou dado ausente no Supabase.
- Ao criar features, preferir **localStorage** em vez de pedir migrations — o usuário prefere mexer pouco no banco.
