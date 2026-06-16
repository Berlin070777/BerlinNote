import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const defaultCacheDir = resolve(root, "..", "audio-cache");
const cacheDir = process.env.AUDIO_CACHE_DIR ? resolve(process.env.AUDIO_CACHE_DIR) : defaultCacheDir;
const port = Number(process.argv[2] || process.env.PORT || 4173);
const bindHost = process.env.BIND_HOST || "0.0.0.0";
const apiKey = process.env.OPENAI_API_KEY || "";
const ttsProvider = (process.env.TTS_PROVIDER || "openai").toLowerCase();
const doubao = {
  apiKey: process.env.DOUBAO_API_KEY || "",
  appId: process.env.DOUBAO_APP_ID || "",
  accessKey: process.env.DOUBAO_ACCESS_KEY || "",
  resourceId: process.env.DOUBAO_RESOURCE_ID || "seed-tts-2.0",
  voiceType: process.env.DOUBAO_VOICE_TYPE || "zh_female_cancan_mars_bigtts"
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg"
};

await mkdir(cacheDir, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && url.pathname === "/api/tts") {
      await handleTts(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        provider: ttsProvider,
        aiTts: ttsProvider === "doubao" ? hasDoubaoAuth() : Boolean(apiKey)
      });
      return;
    }
    await serveStatic(url, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(port, bindHost, () => {
  const local = `http://localhost:${port}/?demo=sample.epub`;
  console.log("");
  console.log("BerlinNote demo is running.");
  console.log("");
  console.log(`Computer: ${local}`);
  console.log("iPhone / iPad: use the LAN address printed by start-mobile-server.sh");
  console.log(`AI TTS provider: ${ttsProvider}`);
  console.log(`AI TTS: ${ttsProvider === "doubao" ? (hasDoubaoAuth() ? "enabled" : "disabled, set DOUBAO credentials") : (apiKey ? "enabled" : "disabled, set OPENAI_API_KEY")}`);
  if (ttsProvider === "doubao") console.log(`Doubao resource: ${doubao.resourceId}, voice: ${doubao.voiceType}`);
  console.log(`Audio cache: ${cacheDir}`);
  console.log("");
});

async function handleTts(req, res) {
  const body = await readJson(req);
  const text = cleanText(body.text || "");
  if (!text) {
    sendJson(res, 400, { error: "Missing text" });
    return;
  }
  if (text.length > 1200) {
    sendJson(res, 400, { error: "Text is too long for one cached clip" });
    return;
  }

  const voice = sanitizeChoice(body.voice, ["marin", "cedar", "alloy", "verse"], "marin");
  const style = sanitizeChoice(body.style, ["calm", "dramatic", "slow", "dialogue"], "calm");
  const rate = clamp(Number(body.rate || 0.9), 0.65, 1.25);
  const key = createCacheKey({
    provider: ttsProvider,
    text,
    voice: ttsProvider === "doubao" ? doubao.voiceType : voice,
    resourceId: ttsProvider === "doubao" ? doubao.resourceId : "",
    style,
    rate
  });
  const filePath = join(cacheDir, `${key}.mp3`);

  if (await exists(filePath)) {
    sendAudio(res, filePath, key, "disk");
    return;
  }

  if (ttsProvider === "doubao" && !hasDoubaoAuth()) {
    sendJson(res, 503, { error: "Doubao TTS is not configured. Set DOUBAO_APP_ID and DOUBAO_ACCESS_KEY, or DOUBAO_API_KEY." });
    return;
  }

  if (ttsProvider !== "doubao" && !apiKey) {
    sendJson(res, 503, { error: "AI TTS is not configured. Set OPENAI_API_KEY before starting the server." });
    return;
  }

  const audio = ttsProvider === "doubao" ? await generateDoubaoSpeech({ text, style, rate }) : await generateOpenAiSpeech({ text, voice, style, rate });
  await writeFile(filePath, audio);
  sendAudio(res, filePath, key, "generated");
}

async function generateOpenAiSpeech({ text, voice, style, rate }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      instructions: buildInstructions(style, rate),
      response_format: "mp3"
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI TTS failed: ${response.status} ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function generateDoubaoSpeech({ text, style, rate }) {
  const ws = await openRawWebSocket("wss://openspeech.bytedance.com/api/v3/tts/bidirection", buildDoubaoHeaders());
  const sessionId = randomUUID();
  const chunks = [];

  return new Promise((resolveSpeech, rejectSpeech) => {
    const timeout = setTimeout(() => {
      ws.close();
      rejectSpeech(new Error("Doubao TTS timed out"));
    }, 45_000);

    let sessionStarted = false;
    let finished = false;

    ws.onMessage = (message) => {
      try {
        const frame = parseDoubaoFrame(message);
        if (frame.error) {
          throw new Error(enhanceDoubaoError(frame.error));
        }
        if (frame.event === 50) {
          ws.send(buildDoubaoJsonFrame(100, buildDoubaoStartSessionPayload(text, style, rate), sessionId));
          return;
        }
        if (frame.event === 150 && !sessionStarted) {
          sessionStarted = true;
          ws.send(buildDoubaoJsonFrame(200, buildDoubaoTaskPayload(text), sessionId));
          ws.send(buildDoubaoJsonFrame(102, {}, sessionId));
          return;
        }
        if (frame.event === 352 && frame.payload?.byteLength) {
          chunks.push(frame.payload);
          return;
        }
        if (frame.event === 152 && !finished) {
          finished = true;
          clearTimeout(timeout);
          ws.send(buildDoubaoJsonFrame(2, {}));
          ws.close();
          resolveSpeech(Buffer.concat(chunks));
        }
        if (frame.event === 153) {
          throw new Error(frame.json?.message || "Doubao session failed");
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        rejectSpeech(error);
      }
    };

    ws.onError = (error) => {
      clearTimeout(timeout);
      rejectSpeech(error);
    };

    ws.send(buildDoubaoJsonFrame(1, {}));
  });
}

function enhanceDoubaoError(message) {
  if (message.includes("resource ID is mismatched with speaker related resource")) {
    return [
      message,
      "Fix: DOUBAO_RESOURCE_ID and DOUBAO_VOICE_TYPE must belong to the same Doubao model resource.",
      "For seed-tts-2.0, choose a voice explicitly listed as a TTS 2.0 voice in the Doubao voice list.",
      "Do not use a TTS 1.0 voice such as zh_female_cancan_mars_bigtts with seed-tts-2.0."
    ].join("\n");
  }
  if (/unauthorized|401/i.test(message)) {
    return [
      message,
      "Fix: Doubao bidirectional WebSocket does not use Authorization: Bearer.",
      "Use old console headers DOUBAO_APP_ID + DOUBAO_ACCESS_KEY, or new console DOUBAO_API_KEY."
    ].join("\n");
  }
  return message;
}

function buildDoubaoHeaders() {
  const headers = {
    "X-Api-Resource-Id": doubao.resourceId
  };
  if (doubao.apiKey) {
    headers["X-Api-Key"] = doubao.apiKey;
  } else {
    headers["X-Api-App-Id"] = doubao.appId;
    headers["X-Api-Access-Key"] = doubao.accessKey;
  }
  return headers;
}

function hasDoubaoAuth() {
  return Boolean(doubao.apiKey || (doubao.appId && doubao.accessKey));
}

function buildDoubaoStartSessionPayload(text, style, rate) {
  const additions = {
    disable_default_bit_rate: true,
    cache_config: {
      text_type: 1,
      use_cache: true,
      use_segment_cache: true
    },
    context_texts: [buildDoubaoInstruction(style, rate)]
  };
  return {
    user: { uid: "berlinnote-reader" },
    event: 100,
    namespace: "BidirectionalTTS",
    req_params: {
      text: "",
      speaker: doubao.voiceType,
      audio_params: {
        format: "mp3",
        sample_rate: 24000,
        bit_rate: 128000
      },
      additions: JSON.stringify(additions)
    }
  };
}

function buildDoubaoTaskPayload(text) {
  return {
    event: 200,
    namespace: "BidirectionalTTS",
    req_params: { text }
  };
}

function buildDoubaoInstruction(style, rate) {
  const pace = rate < 0.8 ? "你可以说慢一点吗？" : rate > 1.08 ? "你可以用自然但稍快一点的语速朗读吗？" : "请用自然的有声书节奏朗读。";
  const styles = {
    calm: "请用沉浸、平静、适合英文文学阅读的旁白语气朗读。",
    dramatic: "请用克制但有张力的戏剧化语气朗读，不要夸张。",
    slow: "请用适合英语学习者精听的清晰语气朗读，短语之间稍作停顿。",
    dialogue: "请用自然对白感朗读，语气要像人物正在说话。"
  };
  return `${styles[style] || styles.calm}${pace}`;
}

function buildDoubaoJsonFrame(event, payload, sessionId = "") {
  const payloadBuffer = Buffer.from(JSON.stringify(payload || {}));
  const parts = [Buffer.from([0x11, 0x14, 0x10, 0x00]), int32(event)];
  if (sessionId) {
    const sessionBuffer = Buffer.from(sessionId);
    parts.push(uint32(sessionBuffer.length), sessionBuffer);
  }
  parts.push(uint32(payloadBuffer.length), payloadBuffer);
  return Buffer.concat(parts);
}

function parseDoubaoFrame(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const messageType = buffer[1] & 0xf0;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] & 0xf0;
  let offset = (buffer[0] & 0x0f) * 4;

  if (messageType === 0xf0) {
    const code = buffer.readInt32BE(offset);
    offset += 4;
    const payload = readPayload(buffer, offset);
    return { error: `Doubao error ${code}: ${decodePayload(payload.payload, serialization)}` };
  }

  const result = { event: 0, payload: Buffer.alloc(0), json: null };
  if (flags === 0x04) {
    result.event = buffer.readInt32BE(offset);
    offset += 4;
  }

  if (result.event >= 50 && result.event < 200) {
    const idLen = buffer.readUInt32BE(offset);
    offset += 4 + idLen;
  } else if (result.event >= 350 || result.event === 352) {
    const sessionLen = buffer.readUInt32BE(offset);
    offset += 4 + sessionLen;
  }

  const payload = readPayload(buffer, offset);
  result.payload = payload.payload;
  if (serialization === 0x10 && result.payload.length) {
    result.json = JSON.parse(result.payload.toString("utf8"));
  }
  return result;
}

function decodePayload(payload, serialization) {
  if (!payload?.length) return "";
  if (serialization === 0x10) return payload.toString("utf8");
  return `<${payload.length} bytes>`;
}

function readPayload(buffer, offset) {
  if (offset + 4 > buffer.length) return { payload: Buffer.alloc(0), offset };
  const len = buffer.readUInt32BE(offset);
  offset += 4;
  return { payload: buffer.subarray(offset, offset + len), offset: offset + len };
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function openRawWebSocket(urlString, extraHeaders) {
  return new Promise((resolveSocket, rejectSocket) => {
    const url = new URL(urlString);
    const key = randomBytes(16).toString("base64");
    const socket = tlsConnect(443, url.hostname, { servername: url.hostname });
    let handshake = Buffer.alloc(0);
    let connected = false;

    const client = {
      readBuffer: Buffer.alloc(0),
      onMessage: null,
      onError: null,
      send(data) {
        socket.write(encodeWebSocketFrame(data));
      },
      close() {
        try {
          socket.end();
        } catch {}
      }
    };

    socket.once("secureConnect", () => {
      const headers = [
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.hostname}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
        "",
        ""
      ].join("\r\n");
      socket.write(headers);
    });

    socket.on("data", (chunk) => {
      if (!connected) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = handshake.subarray(0, end).toString("utf8");
        if (!head.includes(" 101 ")) {
          rejectSocket(new Error(`Doubao websocket handshake failed: ${head.split("\r\n")[0]}`));
          socket.end();
          return;
        }
        connected = true;
        resolveSocket(client);
        const rest = handshake.subarray(end + 4);
        if (rest.length) handleWebSocketData(rest, client);
        return;
      }
      handleWebSocketData(chunk, client);
    });

    socket.on("error", (error) => {
      if (!connected) rejectSocket(error);
      else client.onError?.(error);
    });
  });
}

function handleWebSocketData(chunk, client) {
  client.readBuffer = Buffer.concat([client.readBuffer, chunk]);
  while (client.readBuffer.length >= 2) {
    const second = client.readBuffer[1];
    let len = second & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (client.readBuffer.length < 4) return;
      len = client.readBuffer.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (client.readBuffer.length < 10) return;
      len = Number(client.readBuffer.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = Boolean(second & 0x80);
    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.readBuffer.length < offset + len) return;
    let payload = client.readBuffer.subarray(offset, offset + len);
    if (masked) {
      const mask = client.readBuffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    const opcode = client.readBuffer[0] & 0x0f;
    client.readBuffer = client.readBuffer.subarray(offset + len);
    if (opcode === 0x2) client.onMessage?.(payload);
    if (opcode === 0x1) client.onError?.(new Error(payload.toString("utf8")));
  }
}

function encodeWebSocketFrame(payload) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x82, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function buildInstructions(style, rate) {
  const pace = rate < 0.8 ? "Read slowly and clearly." : rate > 1.08 ? "Read with a natural but slightly brisk pace." : "Read at a natural literary audiobook pace.";
  const styles = {
    calm: "Use a calm, immersive literary narrator voice with precise pauses.",
    dramatic: "Use a restrained dramatic tone, bringing out tension without sounding exaggerated.",
    slow: "Use a clear teaching voice for language learners, with gentle pauses after clauses.",
    dialogue: "Use a conversational tone suitable for dialogue, with natural rhythm and intent."
  };
  return `${styles[style] || styles.calm} ${pace}`;
}

async function serveStatic(url, res) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const candidate = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(root, `.${candidate}`);
  if (!filePath.startsWith(resolve(root))) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!(await exists(filePath))) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
  });
  createReadStream(filePath).pipe(res);
}

function sendAudio(res, filePath, key, cacheStatus) {
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "X-Audio-Cache-Key": key,
    "X-Audio-Cache": cacheStatus,
    "Cache-Control": "public, max-age=31536000, immutable"
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolveRequest, rejectRequest) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_000) {
        req.destroy();
        rejectRequest(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveRequest(JSON.parse(raw || "{}"));
      } catch (error) {
        rejectRequest(error);
      }
    });
    req.on("error", rejectRequest);
  });
}

function createCacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function sanitizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
