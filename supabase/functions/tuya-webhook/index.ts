import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TUYA_ACCESS_ID = Deno.env.get("TUYA_ACCESS_ID")!;
const TUYA_ACCESS_SECRET = Deno.env.get("TUYA_ACCESS_SECRET")!;

async function md5hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "MD5",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// AES-128-ECB decrypt (Tuya webhook payload encryption)
async function aesEcbDecrypt(cipherB64: string, keyStr: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(keyStr).slice(0, 16);
  const cipherBytes = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" }, // Deno doesn't support ECB natively; we'll do manual ECB
    false,
    ["decrypt"],
  );

  // ECB = CBC with zero IV, block by block
  const blockSize = 16;
  const plainBytes: number[] = [];
  const zeroIV = new Uint8Array(16);

  for (let i = 0; i < cipherBytes.length; i += blockSize) {
    const block = cipherBytes.slice(i, i + blockSize);
    // Pad to 32 bytes (one block + one dummy block) since CBC needs at least 2 blocks
    const padded = new Uint8Array(blockSize * 2);
    padded.set(block, 0);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: zeroIV },
      key,
      padded,
    );
    plainBytes.push(...new Uint8Array(decrypted).slice(0, blockSize));
  }

  // Remove PKCS7 padding
  const last = plainBytes[plainBytes.length - 1];
  const unpadded = plainBytes.slice(0, plainBytes.length - last);
  return new TextDecoder().decode(new Uint8Array(unpadded));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Tuya URL verification: GET with ?check_code=XXX
  if (req.method === "GET") {
    const checkCode = url.searchParams.get("check_code");
    if (checkCode) {
      return new Response(JSON.stringify({ code: "0", data: checkCode }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ code: "0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Always respond 200 {"code":"0"} to Tuya within 3s
  // We process async after responding
  const bodyText = await req.text();

  // Parse outer envelope
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ code: "0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify signature: MD5(access_id + access_secret + t + data).toUpperCase()
  const t = String(envelope.t ?? "");
  const data = String(envelope.data ?? "");
  const expectedSig = await md5hex(TUYA_ACCESS_ID + TUYA_ACCESS_SECRET + t + data);
  const receivedSig = String(envelope.sign ?? "").toUpperCase();

  if (receivedSig !== expectedSig) {
    console.warn("Tuya webhook: signature mismatch", { receivedSig, expectedSig });
    return new Response(JSON.stringify({ code: "0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Decrypt payload
  const decryptKey = (await md5hex(TUYA_ACCESS_SECRET)).slice(0, 16);
  let payload: Record<string, unknown>;
  try {
    const plainText = await aesEcbDecrypt(data, decryptKey);
    payload = JSON.parse(plainText);
  } catch (e) {
    console.error("Tuya webhook: decrypt/parse error", e);
    return new Response(JSON.stringify({ code: "0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Process in background (don't block response)
  EdgeRuntime?.waitUntil(processPayload(payload));

  return new Response(JSON.stringify({ code: "0" }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function processPayload(payload: Record<string, unknown>) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Two formats Tuya may send:
    // Format A: { devId, status: [{code, value}] }
    // Format B: { bizCode: "statusReport", bizData: { devId, status: [{code, value}] } }
    let devId: string | undefined;
    let statusList: Array<{ code: string; value: unknown }> = [];

    if (typeof payload.bizCode === "string" && payload.bizData) {
      const biz = payload.bizData as Record<string, unknown>;
      devId = String(biz.devId ?? "");
      statusList = (biz.status as Array<{ code: string; value: unknown }>) ?? [];
    } else if (payload.devId) {
      devId = String(payload.devId);
      statusList = (payload.status as Array<{ code: string; value: unknown }>) ?? [];
    }

    if (!devId || statusList.length === 0) {
      console.log("Tuya webhook: no devId or status in payload", payload);
      return;
    }

    // Find all devices matching this tuya_device_id
    const { data: devices, error } = await supabase
      .from("devices")
      .select("id, tuya_switch_code")
      .eq("tuya_device_id", devId);

    if (error || !devices || devices.length === 0) {
      console.log("Tuya webhook: device not found", devId);
      return;
    }

    for (const device of devices) {
      const switchCode = device.tuya_switch_code ?? "switch_1";
      const match = statusList.find((s) => s.code === switchCode);
      if (!match) continue;

      const newStatus = match.value === true || match.value === "true" || match.value === 1;

      const { error: updateError } = await supabase
        .from("devices")
        .update({
          status: newStatus,
          last_source: "webhook",
          last_changed: new Date().toISOString(),
        })
        .eq("id", device.id);

      if (updateError) {
        console.error("Tuya webhook: update error", updateError);
      } else {
        console.log(`Tuya webhook: updated device ${device.id} (${devId}/${switchCode}) → ${newStatus}`);
      }
    }
  } catch (e) {
    console.error("Tuya webhook: processPayload error", e);
  }
}

// Deno Deploy / Supabase Edge Runtime compatibility
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined;
