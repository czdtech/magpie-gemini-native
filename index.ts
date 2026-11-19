// Bridges magpie's OpenAI-shaped retrieval routes to Google AI Studio's native protocols:
//   POST /v1/audio/speech {model, input, voice?, response_format?}  →  POST /v1beta/models/<model>:generateContent
//     with generationConfig.responseModalities:["AUDIO"] (+ speechConfig voice), returning the WAV bytes.
//   POST /v1/embeddings   {model, input | input[]}                  →  POST /v1beta/models/<model>:embedContent
//     (or :batchEmbedContents for arrays), returning the OpenAI {object:"list", data:[...]} shape.
// Models are marked with capabilities.output kinds (audio / embedding) so magpie keeps them out of
// chat lists (#3279) while serveRetrieval still routes to them by name. The factory must not need
// the key to load: the auth loader picks it up per sign-in (unlike a factory-time KeyPool).

const PROVIDER = "gemini-native"
const GOOGLE = "https://generativelanguage.googleapis.com/v1beta"
const DEFAULT_VOICE = "Aoede"

// The models the plugin serves, with the kinds each one gives. output kinds name no text,
// so magpie leaves every one out of chat lists; serveRetrieval still routes by name.
const MODELS: Record<string, any> = {
  "gemini-3.8-flash-tts": {
    name: "Gemini 3.8 Flash TTS",
    capabilities: { input: { text: true, image: false }, output: { text: false, audio: true } },
    limit: { context: 8192, output: 1 },
  },
  "gemini-2.5-flash-preview-tts": {
    name: "Gemini 2.5 Flash Preview TTS",
    capabilities: { input: { text: true, image: false }, output: { text: false, audio: true } },
    limit: { context: 8192, output: 1 },
  },
  "gemini-embedding-2": {
    name: "Gemini Embedding 2",
    capabilities: { input: { text: true, image: false }, output: { text: false, embedding: true } },
    limit: { context: 8192, output: 1 },
  },
}

function ownId(model: string): string {
  // serveRetrieval names the model provider/model; a stray prefix is stripped defensively.
  return String(model ?? "").replace(/^gemini-native\//, "")
}

function wavFromPCM(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const byteRate = sampleRate * channels * 2
  const write = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  write(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); write(8, "WAVE")
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true)
  write(36, "data"); view.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(header); out.set(pcm, 44)
  return out
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function fail(err: any): Response {
  const status = err?.status ?? 502
  const message = err?.message ?? String(err)
  console.error(`[${PROVIDER}] error:`, status, message)
  return json({ error: { message, type: "plugin_error" } }, status)
}

async function embeddings(body: any, key: string, init: any): Promise<Response> {
  const modelId = body.model || "gemini-embedding-2"
  const inputs = Array.isArray(body.input) ? body.input : [body.input]
  const requests = inputs.map((text: any) => ({ model: `models/${modelId}`, content: { parts: [{ text: String(text) }] } }))
  const isBatch = requests.length > 1
  const path = isBatch ? "/models:batchEmbedContents" : `/models/${modelId}:embedContent`
  const res = await fetch(GOOGLE + path, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(isBatch ? { requests } : requests[0]),
    signal: init.signal,
    ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
      ? { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY } as any : {}),
  } as any)
  const text = await res.text()
  if (!res.ok) {
    console.error(`[${PROVIDER}] Google embeddings error:`, res.status, text)
    return json({ error: { message: `Google embeddings error ${res.status}: ${text.slice(0, 300)}`, type: "upstream_error" } }, 502)
  }
  const data = JSON.parse(text)
  const list = isBatch
    ? data.embeddings.map((e: any, i: number) => ({ object: "embedding", index: i, embedding: e.values }))
    : [{ object: "embedding", index: 0, embedding: data.embedding?.values || [] }]
  return json({ object: "list", data: list, model: modelId, usage: { prompt_tokens: 0, total_tokens: 0 } })
}

async function speech(body: any, key: string, init: any): Promise<Response> {
  const modelId = body.model || "gemini-3.8-flash-tts"
  const voice = body.voice || DEFAULT_VOICE
  const input = body.input ?? ""
  const responseFormat = body.response_format || "wav"

  const gBody: any = {
    contents: [{ role: "user", parts: [{ text: String(input) }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  }
  gBody.generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }

  const path = `/models/${modelId}:generateContent`
  const res = await fetch(GOOGLE + path, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(gBody),
    signal: init.signal,
    ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
      ? { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY } as any : {}),
  } as any)
  const text = await res.text()
  if (!res.ok) {
    console.error(`[${PROVIDER}] Google speech error:`, res.status, text)
    return json({ error: { message: `Google speech error ${res.status}: ${text.slice(0, 300)}`, type: "upstream_error" } }, 502)
  }
  const data = JSON.parse(text)
  const candidate = data.candidates?.[0]
  const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith("audio/"))
  if (!audioPart) {
    console.error(`[${PROVIDER}] Google speech: no audio in response`, text.slice(0, 300))
    return json({ error: { message: "Google returned no audio for this TTS request", type: "upstream_error" } }, 502)
  }
  const mimeType: string = audioPart.inlineData.mimeType
  const bytes = Uint8Array.from(atob(audioPart.inlineData.data), (c) => c.charCodeAt(0))
  if (mimeType.includes("wav")) {
    return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/wav" } })
  }
  if (responseFormat === "pcm") {
    return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/pcm" } })
  }
  const rate = Number(mimeType.match(/rate=(\d+)/)?.[1] ?? 24000)
  return new Response(wavFromPCM(bytes, rate), { status: 200, headers: { "Content-Type": "audio/wav" } })
}

export const GeminiNativePlugin = async () => ({
  config: async (cfg: any) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Gemini Native (TTS · Embedding)",
      api: GOOGLE,
      models: JSON.parse(JSON.stringify(MODELS)),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "Google AI Studio key", placeholder: "AQ.…" }],
    async loader(getAuth: any) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      const key = auth.key
      return {
        baseURL: GOOGLE,
        async fetch(input: any, init: any) {
          try {
            const path = typeof input === "string" ? new URL(input).pathname : String(input?.url ?? "")
            const body = JSON.parse(init.body)
            const model = ownId(body.model)
            if (path.endsWith("/embeddings")) return await embeddings({ ...body, model }, key, init)
            if (path.endsWith("/audio/speech")) return await speech({ ...body, model }, key, init)
            return json({ error: { message: `Unsupported retrieval path: ${path}`, type: "plugin_error" } }, 404)
          } catch (err: any) {
            return fail(err)
          }
        },
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider: any) {
      return provider.models
    },
  },
})

export default GeminiNativePlugin
