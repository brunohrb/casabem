# casa BEM — CLAUDE.md

Notas de contexto pra sessões futuras do Claude Code. Mantenha curto e
atualizado. Se uma seção ficar obsoleta, **edita ou apaga** — não acumula
informação morta.

---

## Stack rápida

- **Frontend**: `index.html` (single-file, ~5k linhas, Vanilla JS + Supabase JS SDK).
- **Backend**: Supabase (Postgres + Auth + Realtime + Edge Functions).
- **Edge Functions** (`supabase/functions/`):
  - `tuya-control` — fala com a Tuya Cloud (control, status, list_devices,
    list_all_devices, list_scenes, trigger_scene, ir_list_remotes, ir_send,
    get_devices_by_home).
  - `tuya-sync` — polling a cada 20s pra detectar interruptor físico /
    comandos via Alexa nativa e atualizar o banco.
  - `timer-worker` — auto-off pendentes a cada 10s.
- **Cron** (pg_cron): roda `tuya-sync` (20s) e `timer-worker` (10s). Ver
  migração `20260421_000100_cron_jobs.sql`.
- **Alexa**: Custom Skill em `alexa-skill/` (voz). Nativa Tuya é skill da
  Amazon, separada — controla luzes/relés via "Alexa, ligar X".

---

## Tuya Cloud Project (estado atual)

- **Projeto**: "Casa Inteligente Bruno"
- **Data Center**: Western America (`https://openapi-ueaz.tuyaus.com`)
- **Trial estendido até 22/10/2026** (extensão concedida em 23/04/2026, dia
  seguinte da expiração original do trial mensal).
- **Cota observada**:
  - Device Pool 50, Controllable Device Pool 10
  - Cloud Develop Base Resource Trial: $0.20/mês refresh
  - Pay-per-use depois: ~$2.48/M chamadas (centavos/mês com uso normal)

### O que rolou em 22-23/04/2026

1. Trial mensal expirou 22/04 → todos endpoints retornavam código
   `28841002 "subscription expired"`.
2. Tentativa de Subscribe to Resource Pack via VAS portal falhou (página
   `iot.tuya.com/cloud/products/detail` não carregava em nenhum browser).
3. Solução: usuário clicou em **Extend Service Trial Period** no painel
   Tuya — aprovado automaticamente, +6 meses.

---

## Controle de IR (ar-condicionado, TV, etc)

Aparelhos pareados num hub IR Tuya **não têm** "Virtual ID" visível no
SmartLife. Tuya expõe via API. A casa BEM tem **3 caminhos** de controle
pra esses devices, em ordem de prioridade no `updateDevice`:

1. **Cena Tuya** (`scene_on_id` / `scene_off_id` no device): chama
   `trigger_scene` no edge function. Bypassa quota do IR Control Hub.
   Ideal quando:
   - O usuário tem cenas (Tap-to-Run) criadas no SmartLife.
   - Quota do IR Open Service tá travada.
2. **IR direto** (`ir_parent_id` no device): chama `control` com
   `device_type` e o edge function tenta múltiplos endpoints
   `/v2.0/infrareds/...`. Precisa do "IR Control Hub Open Service"
   subscrito **com Resource Pack ativo** (pool de devices controlados).
3. **Switch direto** (relé Wi-Fi normal): `/v1.0/devices/{id}/commands`
   com `switch_code` (default `switch_1`).

### Botões úteis no dashboard

- **📡 Descobrir IR** — dado o tuya_device_id do hub, lista os remotes
  pareados e cria devices com `ir_parent_id` setado.
- **🎬 Cenas Tuya** — lista cenas Tap-to-Run e permite testar disparo
  direto. Cenas sobrevivem mesmo "deletadas" no SmartLife (só somem da
  view local; a cloud preserva).
- **🔄 Sincronizar SmartLife** — full sync com expansão de IR e
  multi-tecla.
- **🗑️ Apagar cômodo** — botão por cômodo (header) com 2 confirmações.

---

## Issue 2 (pendente): interruptor físico não atualiza dashboard

Sintoma: usuário liga luz no interruptor de parede → dashboard continua
mostrando "Desligado".

Causa provável: cron `casabem_tuya_sync` não tá rodando OU está rodando
mas falhando.

Diagnóstico via SQL Editor:

```sql
-- Ver se cron existe e tá ativo
select jobname, schedule, active from cron.job where jobname like 'casabem%';

-- Ver últimas execuções
select j.jobname, r.status, r.start_time, r.return_message
from cron.job j join cron.job_run_details r on r.jobid = j.jobid
where j.jobname like 'casabem%' order by r.start_time desc limit 20;
```

Possíveis cenários:
- `relation "cron.job" does not exist` → habilitar `pg_cron` em
  Database → Extensions.
- Sem job `casabem_tuya_sync` → rodar `20260421_000100_cron_jobs.sql`
  **substituindo** `SUPABASE_URL_AQUI` + `SERVICE_ROLE_KEY_AQUI` antes.
- Job existe mas erros nas execuções → ver `return_message`.

---

## Plano futuro: TinyTuya local (outubro/2026)

Quando o trial estendido expirar (~22/10/2026), opções:

1. **Pay-as-you-go** — cadastrar cartão na Tuya. Custo real ~3 centavos
   USD/mês. Ideal pra preguiçoso.
2. **Pular DC** — criar projeto novo em India/China/Europe DC pra +1
   mês free. Gambiarra, cada troca exige re-link SmartLife + atualizar
   secrets Supabase.
3. **TinyTuya local** ← **este é o plano preferido pelo usuário**.

### Preparação pra TinyTuya

- **Hardware disponível**: PC do usuário em casa, sempre ligado.
- **Pré-requisitos** quando for fazer:
  - Tuya Cloud funcionando uma vez pra rodar `tinytuya wizard` e extrair
    `localKey` de cada device. Já temos via projeto atual até 22/10.
  - Mesma LAN dos aparelhos.
- **Setup esperado** (~1 dia de trabalho):
  - Python + `tinytuya` no PC.
  - `tinytuya wizard` → gera `devices.json` com keys.
  - Pequeno servidor HTTP (Python/Node) que recebe `POST /control` do
    casa BEM e dispara `device.set_status()` via TinyTuya.
  - Cloudflare Tunnel free pra expor o servidor com URL pública sem
    mexer em router.
  - Edge function nova `local-control` que faz proxy pra essa URL.
  - Coluna nova `local_url` no `devices` (ou config global) e roteamento
    no `updateDevice` priorizando local sobre Tuya Cloud.

Vantagens: zero dependência de Tuya Cloud daí em diante, latência menor
(LAN local), sem quota.

---

## Convenções & gotchas

- **`asArray<T>(x)`** em `tuya-control/index.ts`: helper que normaliza
  responses da Tuya que às vezes vêm como objeto e às vezes como array.
  **Use ele em qualquer iteração** sobre `r.result` / nested.
- **Multi-tecla**: interruptores Tuya têm canais `switch_1`, `switch_2`,
  ..., `switch_led`. O sync expande cada canal como entrada separada
  no modal Sincronizar. `tuya_switch_code` no device guarda qual é.
- **Toast errors**: quando uma chamada falha, o toast inclui `msg` ou
  `error` da Tuya. Use isso pra debugar em vez de adivinhar.
- **Realtime**: o frontend tem subscription via `subscribeRealtime()`.
  Mudanças em `devices` propagam pro dashboard sem reload.

---

## Comandos úteis

```bash
# Validar que o JS do index.html não tem erro de sintaxe
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const vm = require('vm');
scripts.forEach((s, i) => {
  try { new vm.Script(s); console.log('script ' + i + ' OK'); }
  catch (e) { console.error('Syntax error ' + i + ':', e.message); }
});
"
```

```bash
# Ver últimos commits e PRs
git log --oneline -10
```
