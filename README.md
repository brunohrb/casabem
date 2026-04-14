# Casa BEM 🏠

Painel web de casa inteligente (HTML único + Supabase) com:
- Controle de dispositivos Tuya (luz, ar-condicionado, TV, aspirador, tomadas)
- Comando de voz com wake-word **"BEM"**
- **Regras de automação** com timer (ex.: Cristaleira ligou → desliga em 1 min)
- **Detecção de interruptor físico** via polling Tuya (a luz ligada "no dedo" também dispara regras)
- Mapa da planta, log de comandos, lembretes, integração com Alexa

## Estrutura

```
casabem/
├── index.html                              # Painel (abrir direto no navegador)
├── logo.png
├── supabase/
│   ├── functions/tuya-control/index.ts     # Edge Function — conversa com a Tuya Cloud
│   └── migrations/001_ir_and_manual_source.sql
└── README.md
```

---

## 🚀 Deploy / Primeira configuração

### 1. Variáveis de ambiente (Supabase → Settings → Edge Functions → Secrets)

```
TUYA_CLIENT_ID = <Access ID do seu Cloud Project na Tuya IoT>
TUYA_SECRET    = <Access Secret>
TUYA_BASE_URL  = https://openapi.tuyaus.com     # Brasil/América
```

> Crie o Cloud Project em https://iot.tuya.com → Cloud → Development → Create.  
> Depois **Link Devices by App Account** e vincule a conta Smart Life que já
> controla seus dispositivos.

### 2. Migration SQL

Rode `supabase/migrations/001_ir_and_manual_source.sql` no SQL Editor do Supabase
(ou via CLI `supabase db push`). Ele adiciona as colunas `tuya_ir_parent_id`
e prepara o enum de `source='manual'`.

### 3. Deploy da Edge Function

```bash
supabase functions deploy tuya-control --project-ref <seu-ref>
```

### 4. Configurar dispositivos no painel

No botão **➕ Novo Dispositivo**, expanda **"⚙️ Integração Tuya"**:

| Tipo | Tuya Device ID | IR Blaster pai |
|---|---|---|
| 💡 Luz / Smart Plug | ID do próprio dispositivo | — |
| 🤖 Aspirador Robô | ID do próprio robô | — |
| 📺 TV | ID do "remote" aprendido no IR Blaster | ID do IR Blaster |
| ❄️ Ar-condicionado | ID do "remote" do AC | ID do IR Blaster |

> Como achar os IDs: no site da Tuya IoT, vá em **Devices** → selecione o
> dispositivo → copie o **Device ID**. Para remotes de TV/AC, são filhos do
> IR Blaster — clique no IR Blaster e veja os Sub Devices.

---

## 🔄 Regras de Automação

Sidebar → **Nova Regra**. Exemplo do caso clássico:

> Quando **Luz da Cristaleira** ligar, após **1 min**, desligar **Luz da Cristaleira**.

A regra dispara se a luz for ligada:
- Pelo painel web
- Pela Alexa (via realtime do Supabase)
- **Manualmente no interruptor** (via polling a cada 15s)
- Pelo app Tuya Smart Life

Cancela o timer automaticamente se alguém desligar antes do prazo.

---

## 🔌 Detecção de interruptor físico

O badge **🔌 Detecção física** no header controla o polling.

- A cada 15s o painel pergunta pra Tuya qual o estado real de cada dispositivo
  que tenha `tuya_device_id`.
- Se estiver diferente do cache local, grava como `last_changed='manual'`,
  registra no log como **🔌 Interruptor** e dispara as regras.
- **Ctrl/Cmd + clique** no badge força uma sincronização imediata.
- Se quiser desativar: clique simples no badge.

---

## 🎙 Comandos de voz (wake word "BEM")

- *"BEM, ligar luz da sala"*
- *"BEM, desligar tudo"*
- *"BEM, ligar o ar do quarto casal"*
- *"BEM, iniciar o aspirador"*
- *"BEM, parar o robô"*

---

## Troubleshooting

**"Tuya não respondeu ⚠️"**
→ Confira se a Edge Function está deployada, credenciais preenchidas, e o
`tuya_device_id` do dispositivo está correto.

**"A regra não dispara quando ligo no interruptor físico"**
1. Verifique se existe uma regra criada pra aquele dispositivo
2. Verifique se o badge **🔌 Detecção física** está laranja (ligado)
3. Dê Ctrl+clique no badge pra forçar sync e ver se aparece toast
4. Abra o console (F12) e veja se há erros nas chamadas pra `tuya-control`
5. Confirme que a Edge Function está na versão nova (suporta `status_all`)

**"TV/AC não liga"**
→ TV e AC exigem **IR Blaster Tuya** físico no ambiente + o campo
`tuya_ir_parent_id` preenchido apontando pra ele. Você também precisa ter
"aprendido" os controles remotos no app Smart Life antes.
