# BerlinNote Demo

一个移动端优先的英文 EPUB 阅读 demo。它现在采用 BerlinNote 的二级结构：一级是书架和导入入口，二级是沉浸式阅读器。

## 当前功能

- 书架首页：展示 BerlinNote、导入 EPUB、样书入口，并预留搜索/社区/笔记入口。
- 本机书架：导入 EPUB 后会保存到浏览器 IndexedDB，第二次打开仍然在书架中。
- 阅读进度：自动保存章节、句子和滚动位置，下次打开同一本书会恢复。
- 阅读二级页：正文铺满屏幕，顶部保留返回、目录、整本朗读、阅读设置和停止朗读。
- 目录抽屉：支持章节跳转、上一章/下一章、当前章节高亮。
- 阅读设置栏：独立于查词，支持字体大小、行距、语速和音色切换。
- 句子朗读：点击句子会朗读并高亮。
- 整本朗读：顶部 `▶︎` 从当前位置开始连续朗读整本。
- 段落朗读：每段末尾有小的 `▶` 标志，点击朗读本段。
- AI 音频缓存：同一句话、同一音色、同一语速只生成一次；后端落盘缓存，前端也会存入 IndexedDB。
- 离线播放：已经生成过的句子音频可以离线复听；没有缓存的句子离线时会退回系统语音。
- 长按查词：长按英文单词才打开词卡，避免普通阅读时误触。
- 点词结果：联网时尝试读取在线英文词典，离线时显示本地兜底释义。

## 本地运行

在这个目录运行，推荐用脚本启动：

```bash
./start-mobile-server.sh
```

它会自动读取项目根目录的 `.env` 文件，并显示电脑和手机分别应该打开的地址。

首次配置可以复制示例文件：

```bash
cp .env.example .env
```

然后编辑 `.env`，填入豆包或 OpenAI 的密钥。之后启动时不需要每次手动 `export`。

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

代码会按双向 WebSocket 的旧版控制台格式发送请求头：

```text
X-Api-App-Key: APP ID
X-Api-Access-Key: Access Token
X-Api-Resource-Id: seed-tts-2.0
X-Api-Connect-Id: 自动生成的 UUID
```

新版控制台，如果你拿到的是 API Key：

```bash
export TTS_PROVIDER=doubao
export DOUBAO_API_KEY="你的 API Key"
export DOUBAO_RESOURCE_ID="seed-tts-2.0"
export DOUBAO_VOICE_TYPE="你的音色 ID"
./start-mobile-server.sh
```

代码会按新版格式发送：

```text
X-Api-Key: API Key
X-Api-Resource-Id: seed-tts-2.0
X-Api-Connect-Id: 自动生成的 UUID
```

当前 BerlinNote 的豆包双向 WebSocket 调用规则：

- 旧版控制台：使用 `X-Api-App-Key`，不是 `X-Api-App-Id`。
- 旧版控制台：使用 `X-Api-Access-Key` 传 Access Token。
- 新版控制台：使用 `X-Api-Key`。
- 两种方式都必须带 `X-Api-Resource-Id` 和 `X-Api-Connect-Id`。
- 当前代码不会给豆包分支发送 `Authorization: Bearer ...` 或 `Authorization: Bearer;...`。

`DOUBAO_VOICE_TYPE` 是文档里的 `<voice_type>`。注意：`DOUBAO_RESOURCE_ID` 必须和音色所属模型匹配；如果使用 `seed-tts-2.0`，请在豆包音色列表里选择明确属于 TTS 2.0 的音色，不要使用 TTS 1.0 示例音色。实际做英文原著阅读时，建议选择适合英文或中英混读的 2.0 音色。页面里的“音色”下拉框会作为本次合成的 voice 传给后端；同一句文本、同一音色、同一语速会共用缓存。

如果没有配置 AI 服务，BerlinNote 会自动退回系统语音朗读。

AI 音频缓存默认放在项目目录的上一级，避免混进源码仓库：

```text
/Users/macbookairm2/编程/BerlinNote/audio-cache/
```

也可以通过环境变量自定义缓存目录：

```bash
export AUDIO_CACHE_DIR="/path/to/audio-cache"
./start-mobile-server.sh
```

浏览器端也会把生成过的 MP3 存入 IndexedDB，供同一台设备离线复听。

验证缓存是否生效：

```text
第一次播放同一句：服务端日志应出现 [audio-cache] miss，然后 [audio-cache] stored
第二次播放同一句、同一音色、同一语速：服务端日志应出现 [audio-cache] hit
```

如果第二次仍然出现 `miss/stored`，先确认没有改变音色或语速；再强制刷新页面，避免 Safari 继续运行旧的前端缓存。

## 本地书架和阅读进度

导入的 EPUB 会保存到当前浏览器的 IndexedDB。只要你没有清理 Safari/浏览器的网站数据，第二次打开 BerlinNote 时，书会继续出现在“本机书架”里。

BerlinNote 会自动保存：

- 书籍文件
- 书名、章节数量、导入时间
- 当前章节、句子位置、滚动位置
- 已生成过的音频缓存

注意：这些数据目前是“本机本浏览器”的本地数据，不会同步到 iCloud 或 GitHub。换设备、换浏览器、清理网站数据后需要重新导入。

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


## 后续可以接入的 AI 功能

- 为每句话生成更细致的朗读导演参数，例如情绪、停顿、角色口吻和语速。
- 加入中文意译、长难句拆解、AI 单词解释和跟读评分。
- 缓存已生成的句子音频，减少重复生成成本。
- 让书架保存已导入书籍、阅读进度、笔记和查词历史。

# BerlinNote TTS朗读服务
本项目开源仅用于个人学习、非盈利测试使用；
禁止任何个人/企业直接复制本项目代码用于付费有声小说、盈利类阅读App等商业场景；
如需商用，请联系作者获取单独授权。
