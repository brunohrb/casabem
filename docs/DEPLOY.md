# 🚀 Deploy — casa BEM

Passo a passo para ativar tudo o que foi reorganizado nessa branch
(`claude/reorganize-alexa-system-y53Kv`).

> **Leve em conta a ordem.** Cada passo depende do anterior. Se algo falhar,
> pare e conserte antes de seguir.

---

## 0. Requisitos

- Acesso ao painel do Supabase (o projeto usado é
  `hisbbtddpoxufvghxqtm`).
- **Supabase CLI** instalado (`npm i -g supabase` ou `brew install supabase/tap/supabase`).
- Credenciais do **Tuya IoT Platform** (Access ID + Access Secret).
- Opcional: conta de dev da Amazon pra publicar a Alexa Skill.

---

## 1. Rodar as migrações SQL

São dois scripts. Podem ser aplicados via **Supabase Studio → SQL Editor**
ou pelo CLI.

### 1.1 · Energia, timers e triggers

Arquivo: [`supabase/migrations/20260421_000000_energy_tracking.sql`](../supabase/migrations/20260421_000000_energy_tracking.sql)

O que ele faz:

- Adiciona `on_since`, `total_on_time_seconds`, `last_tuya_sync_at` e
  `last_source` em `devices`.
- Relaxa a constraint `devices_type_check` para aceitar `'vacuum'`.
- Expande o CHECK de `commands_log.source` (para aceitar
  `manual`, `rule`, `manual_timer`, `tuya-sync`, `app`).
- Cria `device_sessions` (histórico de cada liga/desliga) e
  `pending_timers` (auto-off persistidos).
- Cria **triggers** que gerenciam `on_since`,
  `total_on_time_seconds` e `device_sessions` sozinhos.
  Isso significa que **qualquer UPDATE em `devices` — app, Alexa
  Skill, tuya-sync, SQL manual — alimenta os indicadores automaticamente.**
- Cria a publicação Realtime para as novas tabelas.

**Como rodar (opção Studio):** cole o conteúdo no SQL Editor e execute.

**Como rodar (opção CLI):**
```bash
supabase link --project-ref hisbbtddpoxufvghxqtm
supabase db push
```

### 1.2 · Cron jobs (pg_cron)

Arquivo: [`supabase/migrations/20260421_000100_cron_jobs.sql`](../supabase/migrations/20260421_000100_cron_jobs.sql)

**ANTES DE RODAR**, edite o arquivo e troque:

- `SUPABASE_URL_AQUI` → `hisbbtddpoxufvghxqtm`
- `SERVICE_ROLE_KEY_AQUI` → sua **service role key**
  (Project Settings → API → `service_role` — **não** a anon).

Esse script:

- Habilita as extensões `pg_cron` e `pg_net` (se ainda não estiverem).
- Cria uma função helper `casabem_invoke_edge(fn)` que faz
  `POST` autenticado em qualquer Edge Function do projeto.
- Agenda:
  - `casabem_tuya_sync` a cada 20 s.
  - `casabem_timer_worker` a cada 10 s.

> **Atenção:** a service role key é poderosa. Ela fica dentro da função
> (só acessível por quem tem acesso ao banco), mas mesmo assim: não
> compartilhe esse arquivo preenchido em lugares públicos.

---

## 2. Deploy das Edge Functions

> 💡 **Modo fácil (recomendado):** a gente tem um GitHub Actions em
> `.github/workflows/deploy-edge-functions.yml` que sobe as 3 functions
> sozinho quando algo em `supabase/functions/**` muda na main — ou
> manualmente via botão "Run workflow" na aba Actions.
>
> Pra isso funcionar, **1 vez apenas**, adicione em
> GitHub → Settings → Secrets and variables → Actions → New secret:
>
> - `SUPABASE_ACCESS_TOKEN` → gere em
>   https://supabase.com/dashboard/account/tokens (botão "Generate new token").
>
> Depois, basta dar push em `supabase/functions/` ou clicar
> "Run workflow" que tudo sobe automaticamente.

Se preferir o modo manual pelo terminal:


### 2.1 · `tuya-control` (já existe, mas garanta a versão canônica)

Código em `supabase/functions/tuya-control/index.ts` (cópia do que já
está na pasta `casa_inteligente/supabase-edge-function/`).

```bash
supabase functions deploy tuya-control
```

Secrets necessários (Project Settings → Edge Functions → Add new secret):

| Nome                 | Valor                                             |
|----------------------|---------------------------------------------------|
| `TUYA_ACCESS_ID`     | Access ID do projeto Tuya IoT                     |
| `TUYA_ACCESS_SECRET` | Access Secret do projeto Tuya IoT                 |
| `TUYA_BASE_URL`      | `https://openapi.tuyaus.com` (ou `.tuyaeu` / `.tuyacn` conforme a região da sua conta Tuya) |

### 2.2 · `tuya-sync` — polling que detecta o interruptor manual

```bash
supabase functions deploy tuya-sync
```

Não precisa de secrets próprios — ele **chama** `tuya-control`
internamente e herda tudo de lá. Mas permita que ele fale com
`tuya-control`: na mesma página de secrets, se ainda não tiver,
adicione:

| Nome              | Valor                                          |
|-------------------|------------------------------------------------|
| `SERVICE_AUTH_KEY` | sua **service role key** (mesma do cron)     |

### 2.3 · `timer-worker` — executor de timers persistidos

```bash
supabase functions deploy timer-worker
```

Precisa de `SERVICE_AUTH_KEY` (mesmo valor do `tuya-sync`).

### 2.4 · Testar na mão

```bash
# Veja se o sync detecta algo:
curl -X POST https://hisbbtddpoxufvghxqtm.supabase.co/functions/v1/tuya-sync \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" -H "Content-Type: application/json" -d '{}'

# Veja se o worker consegue rodar (pode não ter timer vencendo agora — é OK):
curl -X POST https://hisbbtddpoxufvghxqtm.supabase.co/functions/v1/timer-worker \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" -H "Content-Type: application/json" -d '{}'
```

A resposta do `tuya-sync` traz `checked` (quantos devices têm
`tuya_device_id`) e `changed` (quantos divergiam do estado real).
Se algum estava divergindo, já foi corrigido no banco.

---

## 3. Testar no dashboard

1. Abra o `index.html` (GitHub Pages, Netlify, etc — como você já usa).
2. Desligue uma lâmpada pelo interruptor físico. **Em até 20 s** o card
   no app deve mudar sozinho e um toast deve aparecer dizendo
   _"🔘 Luz X desligada pelo interruptor"_. A badge fica laranja
   (🔘 Interruptor).
3. Ligue uma lâmpada pelo app → o card deve mostrar **"⏱️ ligado há Xs"**
   que começa a contar.
4. Clique no botão `⏲️ Desligar em…` do card → agende 2 min → feche o
   navegador. Abra de novo antes de vencer o timer — o countdown
   continua. Se abrir depois, a lâmpada já vai estar desligada (foi o
   `timer-worker`).
5. Abra as **Ações Rápidas → ⚡ Consumo / Uso** pra ver o tempo total
   acumulado de cada aparelho.

---

## 4. Troubleshooting

### "Erro ao agendar timer"
- A tabela `pending_timers` não existe → migração 1.1 não rodou, ou
  rodou em um projeto diferente.

### O sync nunca corrige o estado
- Checar logs do Edge Function: Project → Edge Functions → `tuya-sync`
  → Logs.
- Se aparecer `Tuya token error` → ajuste `TUYA_BASE_URL` (região
  errada é o mais comum).

### O cron não executa
- Extensões `pg_cron` / `pg_net` precisam estar habilitadas em
  Database → Extensions.
- Verifique `select * from cron.job_run_details order by start_time desc limit 20;`
  para ver erros.

### `commands_log` bloqueando inserts
- Se você já rodou a migração em outro tenant e o schema divergiu,
  a CHECK constraint pode estar como no script original. Rode de
  novo o bloco `alter table public.commands_log drop constraint ...`
  e `add constraint ... check (source in (...))`.

---

## 5. Ordem de rollback (se precisar reverter)

1. `select cron.unschedule('casabem_tuya_sync'); select cron.unschedule('casabem_timer_worker');`
2. `drop trigger trg_devices_sessions on public.devices; drop trigger trg_devices_on_since on public.devices;`
3. (Opcional) `drop table public.pending_timers; drop table public.device_sessions;`
4. Reimplantar o `index.html` da `main` antes desta branch.
