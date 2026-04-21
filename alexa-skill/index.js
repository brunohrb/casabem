/**
 * ============================================================
 * ALEXA SKILL - CASA INTELIGENTE DO BRUNO
 * ============================================================
 * Versão: 1.0.0
 * Idioma: Português (Brasil)
 *
 * ATENÇÃO: Altere as configurações abaixo antes de usar!
 * ============================================================
 */

const Alexa = require('ask-sdk-core');
const https = require('https');

// ============================================================
// ⚙️  CONFIGURAÇÃO — ALTERE AQUI COM SEUS DADOS DO SUPABASE
// ============================================================
const CONFIG = {
  SUPABASE_URL:  'https://egonicvreizaknzwqvbt.supabase.co',
  SUPABASE_KEY:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnb25pY3ZyZWl6YWtuendxdmJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxOTQ2ODIsImV4cCI6MjA4OTc3MDY4Mn0.MRNFahn8obGmRHowMliJUIzdcO_CSa-z3IX1RlXdDgw',
};
// ============================================================


// ============================================================
// 🔧 FUNÇÕES AUXILIARES - SUPABASE REST API
// ============================================================

/**
 * Faz uma requisição autenticada para a REST API do Supabase
 */
function supabaseRequest(method, tablePath, body = null) {
  return new Promise((resolve, reject) => {
    const host    = CONFIG.SUPABASE_URL.replace('https://', '');
    const path    = `/rest/v1/${tablePath}`;
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: host,
      path:     path,
      method:   method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        CONFIG.SUPABASE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
        'Prefer':        'return=representation',
      },
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', (err) => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Busca dispositivos pelo tipo e/ou cômodo
 */
async function buscarDispositivos(tipo = null, comodo = null) {
  let query = 'devices?select=*';
  const filtros = [];
  if (tipo)   filtros.push(`type=eq.${tipo}`);
  if (comodo) filtros.push(`room=ilike.*${comodo}*`);
  if (filtros.length > 0) query += '&' + filtros.join('&');

  const resp = await supabaseRequest('GET', query);
  return Array.isArray(resp.body) ? resp.body : [];
}

/**
 * Atualiza o status/configuração de um dispositivo
 */
async function atualizarDispositivo(id, campos) {
  const resp = await supabaseRequest('PATCH', `devices?id=eq.${id}`, campos);
  return resp;
}

/**
 * Registra um comando no log
 */
async function registrarLog(deviceId, deviceName, comando, sucesso = true) {
  await supabaseRequest('POST', 'commands_log', {
    device_id:   deviceId,
    device_name: deviceName,
    command:     comando,
    source:      'alexa',
    success:     sucesso,
  });
}

/**
 * Cria um lembrete no banco
 */
async function criarLembrete(titulo, descricao = null) {
  const resp = await supabaseRequest('POST', 'reminders', {
    title:       titulo,
    description: descricao,
    source:      'alexa',
  });
  return resp;
}

// ============================================================
// 🗂️  MAPEAMENTO DE NOMES (português falado → banco de dados)
// ============================================================

const TIPO_MAP = {
  'luz':          'light',
  'luzes':        'light',
  'lâmpada':      'light',
  'lâmpadas':     'light',
  'iluminação':   'light',
  'ar':           'ac',
  'ar condicionado': 'ac',
  'arcondicionado':  'ac',
  'tv':           'tv',
  'televisão':    'tv',
  'televisor':    'tv',
  'smart tv':     'tv',
};

const COMODO_MAP = {
  'sala':        'Sala',
  'quarto':      'Quarto',
  'cozinha':     'Cozinha',
  'banheiro':    'Banheiro',
  'escritório':  'Escritório',
  'varanda':     'Varanda',
  'garagem':     'Garagem',
};

function normalizarTipo(slot) {
  if (!slot) return null;
  const val = slot.toLowerCase().trim();
  return TIPO_MAP[val] || null;
}

function normalizarComodo(slot) {
  if (!slot) return null;
  const val = slot.toLowerCase().trim();
  return COMODO_MAP[val] || val;
}

function slotValue(handlerInput, slotName) {
  try {
    const slots = handlerInput.requestEnvelope.request.intent.slots;
    if (slots && slots[slotName] && slots[slotName].value) {
      return slots[slotName].value.toLowerCase().trim();
    }
  } catch (e) {}
  return null;
}


// ============================================================
// 🎙️  HANDLERS — Cada um responde a um tipo de comando
// ============================================================

/**
 * LaunchRequest — quando o usuário abre a skill sem comando específico
 * "Alexa, abrir minha casa"
 */
const LaunchHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest';
  },
  async handle(input) {
    const dispositivos = await buscarDispositivos();
    const ativos = dispositivos.filter(d => d.status).length;
    const total  = dispositivos.length;

    const fala = `Olá Bruno! Bem-vindo à sua casa inteligente. ` +
      `Você tem ${total} dispositivo${total !== 1 ? 's' : ''} cadastrado${total !== 1 ? 's' : ''}, ` +
      `sendo ${ativos} ativo${ativos !== 1 ? 's' : ''} no momento. ` +
      `O que você quer fazer?`;

    return input.responseBuilder
      .speak(fala)
      .reprompt('O que você quer controlar? Você pode ligar ou desligar luzes, ar condicionado ou TV.')
      .withSimpleCard('Casa Inteligente 🏠', fala)
      .getResponse();
  },
};

/**
 * LigarDispositivoIntent — liga um dispositivo
 * "ligar a luz da sala" / "ligar o ar do quarto"
 */
const LigarDispositivoHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'LigarDispositivoIntent';
  },
  async handle(input) {
    const tipoSlot  = slotValue(input, 'dispositivo');
    const comodoSlot = slotValue(input, 'comodo');

    const tipo   = normalizarTipo(tipoSlot);
    const comodo = normalizarComodo(comodoSlot);

    const dispositivos = await buscarDispositivos(tipo, comodo);

    if (dispositivos.length === 0) {
      const desc = [tipoSlot, comodoSlot].filter(Boolean).join(' d');
      return input.responseBuilder
        .speak(`Não encontrei nenhum dispositivo ${desc ? 'chamado ' + desc : ''} cadastrado. Verifique o painel.`)
        .getResponse();
    }

    let ligados = 0;
    for (const d of dispositivos) {
      if (!d.status) {
        await atualizarDispositivo(d.id, { status: true, last_changed: 'alexa' });
        await registrarLog(d.id, d.name, `Ligar ${d.name}`, true);
        ligados++;
      }
    }

    let fala;
    if (dispositivos.length === 1) {
      const d = dispositivos[0];
      fala = d.status && ligados === 0
        ? `${d.name} já estava ligad${d.type === 'ar' ? 'o' : 'a'}.`
        : `${d.name} ligad${d.type === 'light' ? 'a' : 'o'} com sucesso!`;
    } else {
      fala = `${ligados} dispositivo${ligados !== 1 ? 's' : ''} ligado${ligados !== 1 ? 's' : ''} com sucesso!`;
    }

    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('✅ Ligado', fala)
      .getResponse();
  },
};

/**
 * DesligarDispositivoIntent — desliga um dispositivo
 * "desligar a luz da cozinha" / "desligar o ar"
 */
const DesligarDispositivoHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'DesligarDispositivoIntent';
  },
  async handle(input) {
    const tipoSlot   = slotValue(input, 'dispositivo');
    const comodoSlot = slotValue(input, 'comodo');

    const tipo   = normalizarTipo(tipoSlot);
    const comodo = normalizarComodo(comodoSlot);

    const dispositivos = await buscarDispositivos(tipo, comodo);

    if (dispositivos.length === 0) {
      return input.responseBuilder
        .speak(`Não encontrei o dispositivo para desligar. Verifique o painel.`)
        .getResponse();
    }

    let desligados = 0;
    for (const d of dispositivos) {
      if (d.status) {
        await atualizarDispositivo(d.id, { status: false, last_changed: 'alexa' });
        await registrarLog(d.id, d.name, `Desligar ${d.name}`, true);
        desligados++;
      }
    }

    let fala;
    if (dispositivos.length === 1) {
      const d = dispositivos[0];
      fala = !d.status && desligados === 0
        ? `${d.name} já estava desligad${d.type === 'ac' ? 'o' : 'a'}.`
        : `${d.name} desligad${d.type === 'light' ? 'a' : 'o'} com sucesso!`;
    } else {
      fala = `${desligados} dispositivo${desligados !== 1 ? 's' : ''} desligado${desligados !== 1 ? 's' : ''}!`;
    }

    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('🔴 Desligado', fala)
      .getResponse();
  },
};

/**
 * DesligarTudoIntent — desliga todos os dispositivos
 * "desligar tudo" / "apagar tudo"
 */
const DesligarTudoHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'DesligarTudoIntent';
  },
  async handle(input) {
    const dispositivos = await buscarDispositivos();
    const ativos = dispositivos.filter(d => d.status);

    if (ativos.length === 0) {
      return input.responseBuilder
        .speak('Tudo já está desligado, Bruno!')
        .getResponse();
    }

    for (const d of ativos) {
      await atualizarDispositivo(d.id, { status: false, last_changed: 'alexa' });
      await registrarLog(d.id, d.name, `Desligar tudo — ${d.name}`, true);
    }

    const fala = `Pronto! ${ativos.length} dispositivo${ativos.length !== 1 ? 's' : ''} desligado${ativos.length !== 1 ? 's' : ''}. Casa no modo economia!`;
    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('🏠 Tudo desligado', fala)
      .getResponse();
  },
};

/**
 * AjustarTemperaturaIntent — muda temperatura do ar condicionado
 * "colocar o ar no quarto para 20 graus"
 */
const AjustarTemperaturaHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'AjustarTemperaturaIntent';
  },
  async handle(input) {
    const tempSlot  = slotValue(input, 'temperatura');
    const comodoSlot = slotValue(input, 'comodo');

    if (!tempSlot) {
      return input.responseBuilder
        .speak('Por favor, me diga a temperatura desejada. Por exemplo: colocar o ar para 22 graus.')
        .reprompt('Qual temperatura você quer?')
        .getResponse();
    }

    const temp   = parseInt(tempSlot);
    const comodo = normalizarComodo(comodoSlot);

    if (isNaN(temp) || temp < 16 || temp > 30) {
      return input.responseBuilder
        .speak('A temperatura deve ser entre 16 e 30 graus.')
        .getResponse();
    }

    const ars = await buscarDispositivos('ac', comodo);

    if (ars.length === 0) {
      return input.responseBuilder
        .speak('Não encontrei ar condicionado cadastrado. Verifique o painel.')
        .getResponse();
    }

    const ar = ars[0];
    await atualizarDispositivo(ar.id, { temperature: temp, status: true, last_changed: 'alexa' });
    await registrarLog(ar.id, ar.name, `Temperatura ajustada para ${temp}°C`, true);

    const fala = `Perfeito! ${ar.name} ajustado para ${temp} graus e ligado.`;
    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('🌡️ Temperatura', fala)
      .getResponse();
  },
};

/**
 * AjustarVolumeIntent — muda volume da TV
 * "aumentar volume da TV" / "colocar a TV no volume 50"
 */
const AjustarVolumeHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'AjustarVolumeIntent';
  },
  async handle(input) {
    const volumeSlot = slotValue(input, 'volume');
    const acaoSlot   = slotValue(input, 'acao'); // 'aumentar' ou 'diminuir'

    const tvs = await buscarDispositivos('tv');

    if (tvs.length === 0) {
      return input.responseBuilder
        .speak('Não encontrei TV cadastrada. Verifique o painel.')
        .getResponse();
    }

    const tv = tvs[0];
    let novoVolume = tv.volume || 30;

    if (volumeSlot) {
      novoVolume = Math.max(0, Math.min(100, parseInt(volumeSlot)));
    } else if (acaoSlot === 'aumentar') {
      novoVolume = Math.min(100, novoVolume + 10);
    } else if (acaoSlot === 'diminuir' || acaoSlot === 'abaixar') {
      novoVolume = Math.max(0, novoVolume - 10);
    }

    await atualizarDispositivo(tv.id, { volume: novoVolume, last_changed: 'alexa' });
    await registrarLog(tv.id, tv.name, `Volume ajustado para ${novoVolume}`, true);

    const fala = `Volume da ${tv.name} ajustado para ${novoVolume}.`;
    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('📺 Volume', fala)
      .getResponse();
  },
};

/**
 * AjustarBrilhoIntent — muda brilho de uma luz
 * "colocar a luz da sala em 50 por cento"
 */
const AjustarBrilhoHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'AjustarBrilhoIntent';
  },
  async handle(input) {
    const brilhoSlot = slotValue(input, 'brilho');
    const comodoSlot  = slotValue(input, 'comodo');

    if (!brilhoSlot) {
      return input.responseBuilder
        .speak('Qual nível de brilho você quer? Por exemplo: luz da sala em 50 por cento.')
        .reprompt('Qual o brilho desejado?')
        .getResponse();
    }

    const brilho = Math.max(0, Math.min(100, parseInt(brilhoSlot)));
    const comodo  = normalizarComodo(comodoSlot);

    const luzes = await buscarDispositivos('light', comodo);

    if (luzes.length === 0) {
      return input.responseBuilder
        .speak('Não encontrei luzes cadastradas. Verifique o painel.')
        .getResponse();
    }

    for (const luz of luzes) {
      await atualizarDispositivo(luz.id, {
        brightness:    brilho,
        status:        brilho > 0,
        last_changed:  'alexa',
      });
      await registrarLog(luz.id, luz.name, `Brilho ajustado para ${brilho}%`, true);
    }

    const fala = luzes.length === 1
      ? `Brilho da ${luzes[0].name} ajustado para ${brilho} por cento.`
      : `Brilho de ${luzes.length} luzes ajustado para ${brilho} por cento.`;

    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('💡 Brilho', fala)
      .getResponse();
  },
};

/**
 * VerStatusIntent — informa o status atual dos dispositivos
 * "qual o status da sala?" / "o que está ligado?"
 */
const VerStatusHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'VerStatusIntent';
  },
  async handle(input) {
    const comodoSlot = slotValue(input, 'comodo');
    const comodo     = normalizarComodo(comodoSlot);

    const dispositivos = await buscarDispositivos(null, comodo || null);

    if (dispositivos.length === 0) {
      return input.responseBuilder
        .speak('Não encontrei dispositivos cadastrados.')
        .getResponse();
    }

    const ativos      = dispositivos.filter(d => d.status);
    const desligados  = dispositivos.filter(d => !d.status);

    let fala = '';
    if (ativos.length === 0) {
      fala = comodo
        ? `Tudo desligado na ${comodo}.`
        : 'Tudo desligado na casa.';
    } else {
      fala = `${ativos.length} dispositivo${ativos.length !== 1 ? 's' : ''} ligado${ativos.length !== 1 ? 's' : ''}: `;
      fala += ativos.map(d => d.name).join(', ') + '. ';
      if (desligados.length > 0) {
        fala += `${desligados.length} desligado${desligados.length !== 1 ? 's' : ''}.`;
      }
    }

    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('📊 Status', fala)
      .getResponse();
  },
};

/**
 * CriarLembreteIntent — cria um lembrete
 * "lembrar de comprar leite" / "criar lembrete de reunião"
 */
const CriarLembreteHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'CriarLembreteIntent';
  },
  async handle(input) {
    const textoSlot = slotValue(input, 'texto');

    if (!textoSlot) {
      return input.responseBuilder
        .speak('O que você quer lembrar? Por exemplo: lembrar de comprar pão.')
        .reprompt('O que devo anotar?')
        .getResponse();
    }

    await criarLembrete(textoSlot);

    const fala = `Anotado! Lembrete criado: ${textoSlot}.`;
    return input.responseBuilder
      .speak(fala)
      .withSimpleCard('📝 Lembrete', fala)
      .getResponse();
  },
};

/**
 * AMAZON.HelpIntent — ajuda
 */
const HelpHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(input) {
    const fala = `Você pode me pedir coisas como: ` +
      `ligar a luz da sala, desligar o ar do quarto, ` +
      `colocar o ar para 22 graus, aumentar o volume da TV, ` +
      `desligar tudo, ou qual o status da casa. O que você quer fazer?`;
    return input.responseBuilder
      .speak(fala)
      .reprompt(fala)
      .getResponse();
  },
};

/**
 * AMAZON.CancelIntent / AMAZON.StopIntent — encerrar
 */
const CancelStopHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.CancelIntent' ||
       Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(input) {
    return input.responseBuilder
      .speak('Até logo, Bruno! Casa segura.')
      .getResponse();
  },
};

/**
 * SessionEndedRequest — sessão encerrada
 */
const SessionEndedHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(input) {
    console.log('Sessão encerrada:', JSON.stringify(input.requestEnvelope.request));
    return input.responseBuilder.getResponse();
  },
};

/**
 * ErrorHandler — captura todos os erros
 */
const ErrorHandler = {
  canHandle() { return true; },
  handle(input, error) {
    console.error('Erro na skill:', error.message);
    return input.responseBuilder
      .speak('Desculpe, ocorreu um erro. Tente novamente.')
      .reprompt('Tente novamente.')
      .getResponse();
  },
};


// ============================================================
// 🚀 EXPORTAR A SKILL
// ============================================================
exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchHandler,
    LigarDispositivoHandler,
    DesligarDispositivoHandler,
    DesligarTudoHandler,
    AjustarTemperaturaHandler,
    AjustarVolumeHandler,
    AjustarBrilhoHandler,
    VerStatusHandler,
    CriarLembreteHandler,
    HelpHandler,
    CancelStopHandler,
    SessionEndedHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .withCustomUserAgent('CasaInteligenteBruno/1.0')
  .lambda();
