# 🎙️ Alexa — casa BEM

A casa BEM fala com a Alexa por **dois caminhos independentes**, e
isso é intencional:

| Caminho                 | Quem controla o físico | Quando usar                                      |
|-------------------------|------------------------|--------------------------------------------------|
| **Tuya Smart Home Skill** (nativa) | Tuya → Alexa          | Voz direta: _"Alexa, ligar luz da sala"_. Controla as lâmpadas/relés Tuya **sem passar pela nossa casa BEM**. |
| **Custom Skill "casa BEM"** (nossa) | Supabase → tuya-control | Frases mais ricas: _"Alexa, pedir à casa BEM para ligar todas as luzes do quarto"_. Registra no `commands_log`, dispara automações. |

Os dois convivem bem porque o **`tuya-sync`** (polling de 20 s)
descobre mudanças feitas por qualquer um dos caminhos e sincroniza
com o Supabase — o dashboard reflete os dois.

---

## 1. Skill nativa da Tuya (pré-requisito)

No app **Alexa** → Skills e Jogos → buscar **"Smart Life"** ou
**"Tuya Smart"** → habilitar → fazer login na sua conta Tuya → a
Alexa descobre os dispositivos.

Depois desse passo, qualquer comando direto _"Alexa, ligar X"_
aciona a Tuya. Nosso app **não precisa estar aberto**. O `tuya-sync`
depois carimba que a mudança veio de `manual` (= fora do nosso app).

## 2. Custom Skill "casa BEM"

Código em [`alexa-skill/`](../alexa-skill/).

Ela existe pra comandos mais complexos que a skill nativa não
entende bem (ex: _"ligar tudo no quarto da Clarinha"_, _"criar
lembrete de tomar remédio"_, _"quanto tempo a Cristaleira ficou
ligada?"_).

### Deploy rápido

1. **Amazon Developer Console** → _Alexa Skills_ → **Create Skill**.
2. Nome `casa BEM`, idioma `Português (BR)`, modelo **Custom**,
   backend **Alexa-hosted (Node.js)**.
3. Na aba **Interaction Model** → **JSON Editor** → cole o
   conteúdo de `alexa-skill/interaction-model-pt-BR.json`.
4. Na aba **Code**:
   - Substitua `index.js` pelo nosso `alexa-skill/index.js`.
   - Substitua `package.json` pelo nosso `alexa-skill/package.json`.
   - **Configure as credenciais** no topo do `index.js`
     (`SUPABASE_URL`, `SUPABASE_KEY`). Use a **anon key** (não a
     service role).
5. **Deploy** → **Build Model** → **Test** (modo _Development_).

Invocação: _"Alexa, abrir casa bem"_ → entra na sessão; aí vai
dando comandos tipo _"ligar as luzes da sala"_.

### Arquitetura interna

A Skill não chama o Tuya diretamente. Ela só escreve em
`public.devices`:

```
Alexa  →  Custom Skill (Lambda)  →  Supabase REST  (devices + commands_log)
                                              │
                                              ▼
                     (próxima rodada de tuya-sync em ≤ 20 s)
                                              │
                                              ▼
                                          tuya-control
                                              │
                                              ▼
                                         Tuya Cloud  →  dispositivo físico
```

Assim a Skill fica super simples (só fala REST) e a responsabilidade
de acionar o hardware fica com o `tuya-control`.

> ⚠️ **Gap conhecido** dessa arquitetura: entre a Skill escrever e o
> `tuya-sync` rodar podem passar até 20 s. Pra voz isso é lento.
>
> **Mitigação possível** (futuro): a própria Skill, depois de
> escrever em `devices`, chama `tuya-control` em `Promise.race`
> com a resposta da Alexa. Não implementado ainda — me avise se
> quiser que eu faça.

### Testando

```bash
# Simula um "ligar luz da sala" direto na Skill local:
curl -X POST https://<seu-skill-endpoint> \
  -H "Content-Type: application/json" \
  -d @alexa-skill/test/sample-request.json
```

Ou use o **Test Simulator** da Amazon Developer Console.

---

## 3. Fluxo combinado (exemplo real)

Cenário: você diz _"Alexa, ligar a luz da sala"_ e em seguida
aperta o interruptor físico pra desligar.

1. **t=0s** — Alexa → Tuya → lâmpada liga.
2. **t=1s** — `tuya-sync` ainda não rodou. Dashboard aberto? Nada.
3. **t≤20s** — `tuya-sync` roda, vê que `devices.status` é `false`
   mas a Tuya diz `true`. Atualiza com `last_source='manual'`.
4. Dashboard recebe via Realtime: card vira laranja 🔘 _Interruptor_
   e começa a contar o tempo ligado.
5. Você aperta o interruptor pra desligar.
6. **t≤20s** — `tuya-sync` vê `false`, atualiza o banco. Trigger
   fecha a sessão em `device_sessions` com `duration_seconds = N`,
   soma em `total_on_time_seconds`.

Resultado: o painel "Consumo / Uso" já reflete o uso real.

---

## 4. Próximos passos que fazem sentido

- **Smart Home Skill própria** (substitui a Tuya nativa). Permite
  que a Alexa "veja" o estado do app, responda _"a luz da cristaleira
  está ligada há 34 minutos"_. Requer AWS Lambda + account linking.
  Muito mais trabalho que a Custom Skill — só vale a pena quando o
  sistema estiver maduro.
- **Webhook Tuya (Pulsar)**: substituir o polling de 20 s por push
  em tempo real. Elimina a latência da detecção manual.
- **RPC para tempo total**: a Skill poderia responder perguntas
  tipo _"quantas horas o ar-condicionado ficou ligado essa semana?"_
  somando direto de `device_sessions`.
