# magpie-gemini-native

为 [Magpie](https://github.com/yetone/magpie) 接入 Google AI Studio 原生协议的两个非对话能力：

- **TTS**：`gemini-3.8-flash-tts`、`gemini-2.5-flash-preview-tts` —— magpie 的 `POST /v1/audio/speech`（OpenAI 形态）转成 Google `generateContent` + `responseModalities:["AUDIO"]` + `speechConfig`，返回 WAV。
- **Embedding**：`gemini-embedding-2` —— magpie 的 `POST /v1/embeddings`（OpenAI 形态，支持数组批量）转成 Google `embedContent` / `batchEmbedContents`，返回 OpenAI list 形态。

magpie 内置的 Google 适配器没有这两个翻译（`Google has no OpenAI-style API for /embeddings|/audio/speech`），本插件用 provider 插件的 fetch 补上，模型以 `capabilities.output` 标记（audio / embedding），不会进入任何 chat 选择列表。

## 安装

```sh
magpie plugin add ~/.config/magpie/local-plugins/gemini-native
```

## 登录

```sh
magpie plugin login gemini-native api <你的 Google AI Studio key>
```

key 与 magpie 里 `gemini-2` 供应商（AI Studio）同源时，消费记在同一配额上。

## 使用

```sh
curl http://127.0.0.1:3425/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-native/gemini-3.8-flash-tts","input":"要念的文本","voice":"Aoede"}'
```

本插件为第三方、未获 Google 背书，走 Google 公开的 AI Studio API，风险自负。不含任何 key；请勿把含 key 的文件提交进仓库。
