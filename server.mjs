import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL(".", import.meta.url));
const defaultCacheDir = resolve(root, "..", "audio-cache");
const booksDir = process.env.BOOKS_DIR ? resolve(process.env.BOOKS_DIR) : resolve(root, "..", "books");
const cacheDir = process.env.AUDIO_CACHE_DIR ? resolve(process.env.AUDIO_CACHE_DIR) : defaultCacheDir;
const port = Number(process.argv[2] || process.env.PORT || 4173);
const bindHost = process.env.BIND_HOST || "0.0.0.0";
const apiKey = process.env.OPENAI_API_KEY || "";
const ttsProvider = (process.env.TTS_PROVIDER || "openai").toLowerCase();
const doubao = {
  authMode: (process.env.DOUBAO_AUTH_MODE || "auto").toLowerCase(),
  apiKey: process.env.DOUBAO_API_KEY || "",
  appId: process.env.DOUBAO_APP_ID || "",
  accessKey: process.env.DOUBAO_ACCESS_KEY || "",
  legacyAppHeader: process.env.DOUBAO_LEGACY_APP_HEADER || "X-Api-App-Key",
  resourceId: process.env.DOUBAO_RESOURCE_ID || "seed-tts-2.0",
  voiceType: process.env.DOUBAO_VOICE_TYPE || "zh_female_vv_uranus_bigtts"
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
await mkdir(booksDir, { recursive: true });

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
    if (req.method === "GET" && url.pathname === "/api/books") {
      await handleBooksList(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/books/import") {
      await handleBookImport(req, url, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/parsed")) {
      await handleParsedBook(url, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/books/")) {
      await handleBookFile(url, res);
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
  if (ttsProvider === "doubao") {
    const auth = getDoubaoAuthConfig();
    console.log(`Doubao resource: ${doubao.resourceId}, voice: ${doubao.voiceType}`);
    console.log(`Doubao auth: ${auth.label}, token ${maskToken(auth.secret)}`);
  }
  console.log(`Audio cache: ${cacheDir}`);
  console.log(`Books folder: ${booksDir}`);
  console.log("");
});

async function handleBooksList(res) {
  sendJson(res, 200, { books: await listFolderBooks() });
}

async function listFolderBooks() {
  const files = (await readdir(booksDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.epub$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const books = await Promise.all(
    files.map(async (fileName) => {
      const filePath = resolve(booksDir, fileName);
      const info = await stat(filePath);
      return {
        id: createCacheKey({ fileName }),
        title: fileName.replace(/\.epub$/i, ""),
        fileName,
        size: info.size,
        updatedAt: info.mtimeMs
      };
    })
  );
  return books;
}

async function handleBookImport(req, url, res) {
  const rawName = url.searchParams.get("name") || "Imported.epub";
  const fileName = safeEpubFileName(rawName);
  const buffer = await readBinary(req, 120 * 1024 * 1024);
  if (!buffer.length) {
    sendJson(res, 400, { error: "Empty EPUB file" });
    return;
  }
  const filePath = resolve(booksDir, fileName);
  if (!filePath.startsWith(resolve(booksDir))) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  await writeFile(filePath, buffer);
  const book = await parseEpubBuffer(buffer);
  const info = await stat(filePath);
  const record = {
    id: createCacheKey({ fileName }),
    title: book.title || fileName.replace(/\.epub$/i, ""),
    fileName,
    size: info.size,
    updatedAt: info.mtimeMs
  };
  sendJson(res, 200, { book: record, parsedBook: book });
}

async function handleParsedBook(url, res) {
  const id = decodeURIComponent(url.pathname.slice("/api/books/".length, -"/parsed".length));
  const filePath = await findBookPathById(id);
  if (!filePath) {
    sendJson(res, 404, { error: "Book not found" });
    return;
  }
  const buffer = await readFile(filePath);
  const book = await parseEpubBuffer(buffer);
  sendJson(res, 200, { parsedBook: book });
}

async function handleBookFile(url, res) {
  const id = decodeURIComponent(url.pathname.slice("/api/books/".length));
  const filePath = await findBookPathById(id);
  if (!filePath) {
    sendJson(res, 404, { error: "Book not found" });
    return;
  }
  if (!filePath.startsWith(resolve(booksDir))) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/epub+zip",
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

async function findBookPathById(id) {
  const files = (await readdir(booksDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.epub$/i.test(entry.name));
  const file = files.find((entry) => createCacheKey({ fileName: entry.name }) === id);
  return file ? resolve(booksDir, file.name) : "";
}

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

  const requestedVoice = cleanText(body.voice || "");
  const openAiVoice = sanitizeChoice(requestedVoice, ["marin", "cedar", "alloy", "verse"], "marin");
  const doubaoVoice = requestedVoice || doubao.voiceType;
  const rate = clamp(Number(body.rate || 0.9), 0.65, 1.25);
  const key = createCacheKey({
    provider: ttsProvider,
    text,
    voice: ttsProvider === "doubao" ? doubaoVoice : openAiVoice,
    resourceId: ttsProvider === "doubao" ? doubao.resourceId : "",
    rate: rate.toFixed(2)
  });
  const filePath = join(cacheDir, `${key}.mp3`);

  if (await isUsableAudioFile(filePath)) {
    console.log(`[audio-cache] hit ${key}`);
    sendAudio(res, filePath, key, "disk");
    return;
  }
  if (await exists(filePath)) {
    console.warn(`[audio-cache] invalid ${key}, regenerating`);
  }
  console.log(`[audio-cache] miss ${key}`);

  if (ttsProvider === "doubao" && !hasDoubaoAuth()) {
    sendJson(res, 503, { error: `Doubao TTS is not configured. ${getDoubaoMissingMessage()}` });
    return;
  }

  if (ttsProvider !== "doubao" && !apiKey) {
    sendJson(res, 503, { error: "AI TTS is not configured. Set OPENAI_API_KEY before starting the server." });
    return;
  }

  const audio = ttsProvider === "doubao"
    ? await generateDoubaoSpeech({ text, voice: doubaoVoice, rate })
    : await generateOpenAiSpeech({ text, voice: openAiVoice, rate });
  if (!isUsableAudioBuffer(audio)) {
    throw new Error(`AI TTS returned invalid audio (${audio.length} bytes)`);
  }
  await writeFile(filePath, audio);
  console.log(`[audio-cache] stored ${key} (${audio.length} bytes)`);
  sendAudio(res, filePath, key, "generated");
}

async function generateOpenAiSpeech({ text, voice, rate }) {
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
      instructions: buildInstructions(rate),
      response_format: "mp3",
      speed: rate
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI TTS failed: ${response.status} ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function generateDoubaoSpeech({ text, voice, rate }) {
  const ws = await openDoubaoWebSocket();
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
          ws.send(buildDoubaoJsonFrame(100, buildDoubaoStartSessionPayload(text, voice, rate), sessionId));
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
      "Fix: Doubao bidirectional WebSocket auth headers must match the console version.",
      "New console: set DOUBAO_AUTH_MODE=api-key and DOUBAO_API_KEY, then BerlinNote sends X-Api-Key + X-Api-Resource-Id + X-Api-Connect-Id.",
      "Old console: set DOUBAO_AUTH_MODE=access-token, DOUBAO_APP_ID and DOUBAO_ACCESS_KEY.",
      "If old-console auth fails, try DOUBAO_LEGACY_APP_HEADER=X-Api-App-Id or X-Api-App-Key according to the console/document version.",
      "Also check token validity, model authorization, and proxy/firewall settings."
    ].join("\n");
  }
  return message;
}

async function openDoubaoWebSocket() {
  const endpoint = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
  const auth = getDoubaoAuthConfig();
  try {
    return await openRawWebSocket(endpoint, buildDoubaoHeaders({ auth }));
  } catch (error) {
    const fallbackHeader = getDoubaoFallbackLegacyHeader(auth);
    if (!fallbackHeader || !/401|unauthorized/i.test(String(error?.message || error))) throw error;
    console.warn(`Doubao auth failed with ${getDoubaoLegacyAppHeader()}, retrying with ${fallbackHeader}.`);
    return openRawWebSocket(endpoint, buildDoubaoHeaders({ auth, legacyAppHeader: fallbackHeader }));
  }
}

function buildDoubaoHeaders({ auth = getDoubaoAuthConfig(), legacyAppHeader = getDoubaoLegacyAppHeader() } = {}) {
  if (!auth.ready) {
    throw new Error(`Doubao auth is incomplete. ${getDoubaoMissingMessage()}`);
  }

  const connectId = randomUUID();
  if (auth.mode === "api-key") {
    return {
      "X-Api-Key": auth.apiKey,
      "X-Api-Resource-Id": doubao.resourceId,
      "X-Api-Connect-Id": connectId
    };
  }

  return {
    [legacyAppHeader]: auth.appId,
    "X-Api-Access-Key": auth.accessKey,
    "X-Api-Resource-Id": doubao.resourceId,
    "X-Api-Connect-Id": connectId
  };
}

function hasDoubaoAuth() {
  return getDoubaoAuthConfig().ready;
}

function getDoubaoAuthConfig() {
  const mode = normalizeDoubaoAuthMode(doubao.authMode);
  const apiKeyValue = normalizeCredential(doubao.apiKey);
  const appIdValue = normalizeCredential(doubao.appId);
  const accessKeyValue = normalizeCredential(doubao.accessKey);

  if (mode === "api-key") {
    return {
      mode,
      ready: Boolean(apiKeyValue),
      label: "X-Api-Key",
      secret: apiKeyValue,
      apiKey: apiKeyValue
    };
  }

  if (mode === "access-token") {
    return {
      mode,
      ready: Boolean(appIdValue && accessKeyValue),
      label: `${getDoubaoLegacyAppHeader()} + X-Api-Access-Key`,
      secret: accessKeyValue,
      appId: appIdValue,
      accessKey: accessKeyValue
    };
  }

  if (apiKeyValue) {
    return {
      mode: "api-key",
      ready: true,
      label: "X-Api-Key",
      secret: apiKeyValue,
      apiKey: apiKeyValue
    };
  }

  return {
    mode: "access-token",
    ready: Boolean(appIdValue && accessKeyValue),
    label: `${getDoubaoLegacyAppHeader()} + X-Api-Access-Key`,
    secret: accessKeyValue,
    appId: appIdValue,
    accessKey: accessKeyValue
  };
}

function normalizeDoubaoAuthMode(mode) {
  if (["auto", "api-key", "access-token"].includes(mode)) return mode;
  return "auto";
}

function getDoubaoLegacyAppHeader() {
  const header = doubao.legacyAppHeader.trim();
  return header === "X-Api-App-Id" ? "X-Api-App-Id" : "X-Api-App-Key";
}

function getDoubaoFallbackLegacyHeader(auth) {
  if (auth.mode !== "access-token") return "";
  return getDoubaoLegacyAppHeader() === "X-Api-App-Key" ? "X-Api-App-Id" : "X-Api-App-Key";
}

function normalizeCredential(value) {
  value = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value || /^your[_-]/i.test(value) || /^你的/.test(value)) return "";
  return value;
}

function getDoubaoMissingMessage() {
  const mode = normalizeDoubaoAuthMode(doubao.authMode);
  if (mode === "api-key") return "Set DOUBAO_API_KEY, or switch DOUBAO_AUTH_MODE to auto/access-token.";
  if (mode === "access-token") return "Set DOUBAO_APP_ID and DOUBAO_ACCESS_KEY, or switch DOUBAO_AUTH_MODE to auto/api-key.";
  return "Set DOUBAO_API_KEY for new-console API Key auth, or set DOUBAO_APP_ID and DOUBAO_ACCESS_KEY for old-console auth.";
}

function maskToken(token) {
  token = String(token || "");
  if (token.length <= 8) return token ? "****" : "missing";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function buildDoubaoStartSessionPayload(text, voice, rate) {
  const additions = {
    disable_default_bit_rate: true,
    cache_config: {
      text_type: 1,
      use_cache: true,
      use_segment_cache: true
    },
    context_texts: [buildDoubaoInstruction(rate)]
  };
  return {
    user: { uid: "berlinnote-reader" },
    event: 100,
    namespace: "BidirectionalTTS",
    req_params: {
      text: "",
      speaker: voice,
      audio_params: {
        format: "mp3",
        sample_rate: 24000,
        bit_rate: 128000
      },
      speed_ratio: rate,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
      emotion: "",
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

function buildDoubaoInstruction(rate) {
  const pace = rate < 0.8 ? "请用较慢语速清晰朗读。" : rate > 1.08 ? "请用自然但稍快的语速朗读。" : "请用自然的有声书节奏朗读。";
  return `请用适合英文原著阅读的沉浸旁白语气朗读。${pace}`;
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
          rejectSocket(new Error(enhanceDoubaoError(`Doubao websocket handshake failed: ${head.split("\r\n")[0]}`)));
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

function buildInstructions(rate) {
  const pace = rate < 0.8 ? "Read slowly and clearly." : rate > 1.08 ? "Read with a natural but slightly brisk pace." : "Read at a natural literary audiobook pace.";
  return `Use a calm, immersive literary narrator voice with precise pauses. ${pace}`;
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
  if (ext === ".html" && filePath === resolve(root, "./index.html")) {
    const html = await renderIndexHtml(filePath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": [".html", ".js", ".css", ".webmanifest"].includes(ext) ? "no-store" : "public, max-age=3600"
  });
  createReadStream(filePath).pipe(res);
}

async function renderIndexHtml(filePath) {
  const html = await readFile(filePath, "utf8");
  const books = await listFolderBooks();
  const markup = books.length
    ? books
        .map(
          (book) => `<a class="saved-book" href="./?folderBook=${encodeURIComponent(book.id)}&v=server-import-12"><strong>${escapeHtml(book.title)}</strong><span>本地 books 文件夹 · ${formatBytes(book.size)}</span></a>`
        )
        .join("")
    : `<div class="empty-bookshelf">还没有书籍。可以导入 EPUB，或者把 EPUB 放进 books 文件夹。</div>`;
  return html.replace('<div id="shelfBooks" class="bookshelf-list"></div>', `<div id="shelfBooks" class="bookshelf-list">${markup}</div>`);
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

async function isUsableAudioFile(filePath) {
  try {
    const info = await stat(filePath);
    if (info.size < 1024) return false;
    const buffer = await readFile(filePath);
    return isUsableAudioBuffer(buffer);
  } catch {
    return false;
  }
}

function isUsableAudioBuffer(buffer) {
  if (!buffer || buffer.length < 1024) return false;
  const startsWithId3 = buffer.subarray(0, 3).toString("ascii") === "ID3";
  const startsWithFrameSync = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  return startsWithId3 || startsWithFrameSync;
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

function readBinary(req, limit) {
  return new Promise((resolveRequest, rejectRequest) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        rejectRequest(new Error("EPUB file is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveRequest(Buffer.concat(chunks)));
    req.on("error", rejectRequest);
  });
}

async function parseEpubBuffer(buffer) {
  const zip = await ServerZipArchive.from(buffer);
  const container = await zip.text("META-INF/container.xml");
  const rootfile = getXmlAttr(container.match(/<rootfile\b[^>]*>/i)?.[0] || "", "full-path");
  if (!rootfile) throw new Error("没有找到 EPUB rootfile。");

  const opfText = await zip.text(rootfile);
  const base = dirname(rootfile);
  const title = decodeEntities(
    tagText(opfText, "dc:title") || tagText(opfText, "title") || "Untitled"
  ).trim();
  const manifest = new Map();
  for (const match of opfText.matchAll(/<item\b[^>]*>/gi)) {
    const item = match[0];
    const id = getXmlAttr(item, "id");
    const href = getXmlAttr(item, "href");
    if (!id || !href) continue;
    manifest.set(id, {
      href: resolvePath(base, href),
      type: getXmlAttr(item, "media-type")
    });
  }

  const spineItems = [];
  for (const match of opfText.matchAll(/<itemref\b[^>]*>/gi)) {
    const item = manifest.get(getXmlAttr(match[0], "idref"));
    if (item && (/xhtml|html/i.test(item.type) || /\.x?html?$/i.test(item.href))) spineItems.push(item);
  }
  if (!spineItems.length) throw new Error("没有找到可阅读章节。");

  const chapters = [];
  for (const item of spineItems) {
    const html = await zip.text(item.href);
    const heading = extractHeading(html) || cleanChapterName(item.href);
    const paragraphs = extractParagraphs(html);
    if (paragraphs.length) chapters.push({ title: heading, paragraphs });
  }
  if (!chapters.length) throw new Error("章节里没有解析到正文。");
  return { title, chapters };
}

function getXmlAttr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function tagText(text, tag) {
  const escaped = tag.replace(":", "\\:");
  const match = text.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function extractHeading(html) {
  const match = html.match(/<(h1|h2|h3|title)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return match ? stripTags(match[2]).replace(/\s+/g, " ").trim() : "";
}

function extractParagraphs(html) {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const blocks = [];
  for (const match of body.matchAll(/<(p|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const line = stripTags(match[2]).replace(/\s+/g, " ").trim();
    if (line.length > 20) blocks.push(line);
  }
  return blocks;
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]+>/g, " "));
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function resolvePath(base, href) {
  const stack = (base + href).split("/");
  const out = [];
  for (const part of stack) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function cleanChapterName(path) {
  return path.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

function safeEpubFileName(name) {
  const cleaned = String(name)
    .replace(/[/:\\?%*"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return /\.epub$/i.test(cleaned) ? cleaned : `${cleaned || "Imported"}.epub`;
}

class ServerZipArchive {
  constructor(buffer, entries) {
    this.buffer = buffer;
    this.entries = entries;
  }

  static async from(buffer) {
    const eocdOffset = findServerEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    let offset = buffer.readUInt32LE(eocdOffset + 16);
    const entries = new Map();

    for (let i = 0; i < entryCount; i += 1) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 中央目录损坏。");
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const uncompressedSize = buffer.readUInt32LE(offset + 24);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return new ServerZipArchive(buffer, entries);
  }

  async text(path) {
    return this.bytes(path).toString("utf8");
  }

  bytes(path) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`EPUB 缺少文件：${path}`);
    const local = entry.localOffset;
    if (this.buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏。");
    const nameLength = this.buffer.readUInt16LE(local + 26);
    const extraLength = this.buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const compressed = this.buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return inflateRawSync(compressed, { finishFlush: 4 });
    throw new Error(`暂不支持这个 EPUB 的 ZIP 压缩方式：${entry.method}`);
  }
}

function findServerEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("这不是有效的 EPUB/ZIP 文件。");
}

function createCacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "EPUB";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
