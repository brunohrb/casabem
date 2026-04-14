-- ============================================================
-- Casa BEM — Migration 001
-- ------------------------------------------------------------
-- Adiciona colunas necessárias para:
--   1) Controle IR (TV e Ar-condicionado) via IR Blaster Tuya
--   2) Detecção de mudança no interruptor físico (source='manual')
-- ============================================================

-- IR Blaster pai (dispositivo Tuya que emite IR para TV/AC)
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS tuya_ir_parent_id TEXT;

COMMENT ON COLUMN public.devices.tuya_ir_parent_id IS
  'ID do IR Blaster Tuya pai (usado por TVs e Ar-condicionados).';

-- Origem da última mudança — agora inclui 'manual' (interruptor físico)
-- Se a coluna last_changed já existir como TEXT, apenas garantimos um default.
ALTER TABLE public.devices
  ALTER COLUMN last_changed SET DEFAULT 'dashboard';

-- Índice para consultas de polling
CREATE INDEX IF NOT EXISTS idx_devices_tuya_id
  ON public.devices (tuya_device_id)
  WHERE tuya_device_id IS NOT NULL;

-- Se commands_log.source for um enum, adiciona 'manual'; se for TEXT, nada a fazer.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'command_source'
  ) THEN
    BEGIN
      ALTER TYPE public.command_source ADD VALUE IF NOT EXISTS 'manual';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$$;
