-- ============================================================
-- SCHEMA DO BANCO DE DADOS - CASA INTELIGENTE DO BRUNO
-- Execute este SQL no Supabase > SQL Editor
-- ============================================================

-- Tabela principal de dispositivos
CREATE TABLE IF NOT EXISTS devices (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  name          TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('light', 'ac', 'tv', 'other')),
  room          TEXT    NOT NULL,
  status        BOOLEAN DEFAULT false,
  icon          TEXT    DEFAULT 'device',
  -- Luzes
  brightness    INTEGER DEFAULT 100 CHECK (brightness BETWEEN 0 AND 100),
  -- Ar condicionado
  temperature   INTEGER DEFAULT 22  CHECK (temperature BETWEEN 16 AND 30),
  ac_mode       TEXT    DEFAULT 'cool' CHECK (ac_mode IN ('cool', 'heat', 'fan', 'auto')),
  -- TV
  volume        INTEGER DEFAULT 30  CHECK (volume BETWEEN 0 AND 100),
  channel       INTEGER DEFAULT 1,
  -- Tuya IoT (ID do dispositivo no app Smart Life / Tuya)
  tuya_device_id TEXT    DEFAULT NULL,
  -- Canal (DP code) p/ interruptores multi-tecla: switch_1, switch_2, ...
  tuya_channel   TEXT    DEFAULT 'switch_1',
  -- Controle
  last_changed  TEXT    DEFAULT 'dashboard',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Adiciona coluna tuya_device_id em tabela existente (se já criada)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tuya_device_id TEXT DEFAULT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tuya_channel   TEXT DEFAULT 'switch_1';

-- Tabela de log de todos os comandos
CREATE TABLE IF NOT EXISTS commands_log (
  id          UUID  DEFAULT gen_random_uuid() PRIMARY KEY,
  device_id   UUID  REFERENCES devices(id) ON DELETE SET NULL,
  device_name TEXT  NOT NULL,
  command     TEXT  NOT NULL,
  source      TEXT  DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'alexa', 'automacao')),
  success     BOOLEAN DEFAULT true,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de lembretes (integração Alexa)
CREATE TABLE IF NOT EXISTS reminders (
  id          UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  title       TEXT    NOT NULL,
  description TEXT,
  remind_at   TIMESTAMPTZ,
  done        BOOLEAN DEFAULT false,
  source      TEXT    DEFAULT 'dashboard',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FUNÇÃO E TRIGGER: atualiza updated_at automaticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_devices_updated_at ON devices;
CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- HABILITAR REALTIME (atualizações em tempo real)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
ALTER PUBLICATION supabase_realtime ADD TABLE commands_log;
ALTER PUBLICATION supabase_realtime ADD TABLE reminders;

-- ============================================================
-- RLS (Row Level Security) - PERMISSÕES
-- Permite que o dashboard e a Alexa leiam/escrevam com a anon key
-- ============================================================
ALTER TABLE devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders     ENABLE ROW LEVEL SECURITY;

-- Política: qualquer um com a chave pode fazer tudo (uso pessoal)
CREATE POLICY "acesso_total_devices"      ON devices       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "acesso_total_commands_log" ON commands_log  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "acesso_total_reminders"    ON reminders     FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- DADOS INICIAIS - Dispositivos de Exemplo
-- (Você pode editar os nomes e cômodos depois no dashboard)
-- ============================================================
INSERT INTO devices (name, type, room, status, icon) VALUES
  ('Luz Principal',       'light', 'Sala',       false, 'lightbulb'),
  ('Luz do Teto',         'light', 'Quarto',     false, 'lightbulb'),
  ('Luz da Cozinha',      'light', 'Cozinha',    false, 'lightbulb'),
  ('Ar Condicionado',     'ac',    'Quarto',     false, 'thermometer'),
  ('TV',                  'tv',    'Sala',        false, 'tv'),
  ('Luz da Varanda',      'light', 'Varanda',    false, 'lightbulb')
ON CONFLICT DO NOTHING;
