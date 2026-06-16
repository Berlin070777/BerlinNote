# BerlinNote Demo

一个移动端优先的英文 EPUB 阅读 demo。它现在采用 BerlinNote 的二级结构：一级是书架和导入入口，二级是沉浸式阅读器。

## 当前功能

- 书架首页：展示 BerlinNote、导入 EPUB、样书入口，并预留搜索/社区/笔记入口。
- 阅读二级页：正文铺满屏幕，顶部保留返回、目录、整本朗读、阅读设置和停止朗读。
- 目录抽屉：支持章节跳转、上一章/下一章、当前章节高亮。
- 阅读设置栏：独立于查词，支持字体大小、行距、语速、声音、朗读风格。
- 句子朗读：点击句子会朗读并高亮。
- 整本朗读：顶部 `▶︎` 从当前位置开始连续朗读整本。
- 段落朗读：每段末尾有小的 `▶` 标志，点击朗读本段。
- AI 音频缓存：同一句话、同一声音/语速/风格只生成一次；后端落盘缓存，前端也会存入 IndexedDB。
- 离线播放：已经生成过的句子音频可以离线复听；没有缓存的句子离线时会退回系统语音。
- 长按查词：长按英文单词才打开词卡，避免普通阅读时误触。
- 点词结果：联网时尝试读取在线英文词典，离线时显示本地兜底释义。

## 本地运行

在这个目录运行，推荐用脚本启动：

```bash
./start-mobile-server.sh
```

它会显示电脑和手机分别应该打开的地址。

也可以手动运行：

```bash
NODE_BIN=/path/to/node ./start-mobile-server.sh 4173
```

然后打开：

```text
http://localhost:4173/
```

打开内置样书：

```text
http://localhost:4173/?demo=sample.epub
```

## 开启 AI 朗读

### 使用 OpenAI

```bash
export OPENAI_API_KEY="你的 key"
./start-mobile-server.sh
```

### 使用豆包语音

旧版控制台，也就是你截图里的 `APP ID + Access Token`：

```bash
export TTS_PROVIDER=doubao
export DOUBAO_APP_ID="你的 APP ID"
export DOUBAO_ACCESS_KEY="你的 Access Token"
export DOUBAO_RESOURCE_ID="seed-tts-2.0"
export DOUBAO_VOICE_TYPE="你的音色 ID"
./start-mobile-server.sh
```

新版控制台，如果你拿到的是 API Key：

```bash
export TTS_PROVIDER=doubao
export DOUBAO_API_KEY="你的 API Key"
export DOUBAO_RESOURCE_ID="seed-tts-2.0"
export DOUBAO_VOICE_TYPE="你的音色 ID"
./start-mobile-server.sh
```

`DOUBAO_VOICE_TYPE` 是文档里的 `<voice_type>`，例如示例中的 `zh_female_cancan_mars_bigtts`。实际做英文原著阅读时，建议在豆包音色列表里选择适合英文或中英混读的音色。

如果没有配置 AI 服务，BerlinNote 会自动退回系统语音朗读。

AI 音频缓存位置：

```text
outputs/epub-reader-demo/audio-cache/
```

浏览器端也会把生成过的 MP3 存入 IndexedDB，供同一台设备离线复听。

## 手机上试

让电脑和手机处于同一 Wi-Fi。启动脚本会自动打印类似这样的手机访问地址：

```text
http://192.168.1.8:4173/?demo=sample.epub
```

注意：手机 Safari 不能打开 `localhost:4173`，因为手机上的 `localhost` 指的是手机自己，不是电脑。

如果脚本没有自动显示 IP，可以在 Mac 的系统设置里查看：

```text
系统设置 > Wi-Fi > 当前网络 > 详细信息 > IP 地址
```

然后手机 Safari 打开：

```text
http://你的Mac局域网IP:4173/?demo=sample.epub
```

## 手机连不上时检查

- 电脑和手机必须在同一个 Wi-Fi，不能一个连热点、一个连路由器访客网络。
- 地址必须用 `http://Mac局域网IP:4173/`，不是 `localhost`。
- 如果 macOS 弹出防火墙提示，允许 Node 接收入站连接。
- 如果开了 VPN、代理、访客网络隔离或 iCloud Private Relay，先临时关闭再试。
- 如果 4173 端口被占用，可以换端口：`./start-mobile-server.sh 8080`，手机打开对应端口。

## command not found

如果看到：

```text
node: command not found
```

请使用当前版本的 `./start-mobile-server.sh`，它会自动寻找 Codex 自带的 Node。

如果仍然找不到，可以指定 Node 路径：

```bash
NODE_BIN=/Applications/Codex.app/Contents/Resources/node ./start-mobile-server.sh
```

## 后续可以接入的 AI 功能

- 为每句话生成更细致的朗读风格指令，例如旁白、对白、紧张、讽刺、慢速精读。
- 加入中文意译、长难句拆解、AI 单词解释和跟读评分。
- 缓存已生成的句子音频，减少重复生成成本。
- 让书架保存已导入书籍、阅读进度、笔记和查词历史。
