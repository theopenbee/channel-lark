# openbee Feishu / Lark channel

Feishu / Lark channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk) and the official [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk). It replaces the Feishu channel that used to be built into openbee and keeps its channel id (`feishu`), config section and session keys.

## Behaviour

- Events arrive over Feishu's long connection (WebSocket), so openbee needs no public address. The App ID and App Secret are checked at startup; rejected credentials stop the channel until the config is fixed.
- Every message the bot receives is handled: direct messages, and in groups whatever Feishu delivers for the granted permissions (usually messages that @ the bot).
- One openbee session per chat and sender (`feishu:<chat_id>:<open_id>`), as before.
- Text, rich text (post), image, file, audio, video, media and sticker messages are supported. Rich text is converted to Markdown-like text (bold, italic, code, links, mentions, code blocks). Attachments up to `max_media_size` bytes, including images, videos and files attached to rich text, are downloaded into openbee's media directory; Feishu does not serve sticker files, so stickers arrive as a placeholder.
- A mention of the bot (`@_user_1`) is turned into `@<bot_name>`, so openbee strips it; other mentions are left as Feishu's keys.
- The bot puts a "Typing" reaction on every message it receives and removes it when it replies.
- Replies quote the original message in groups and are plain messages in direct chats. If the original message was withdrawn, the reply is posted to the chat instead. Text is sent as a rich-text post with Markdown, one paragraph per line; text is sent first, then the file. Images are sent as images, `.mp4`/`.mov`/`.avi` as videos, `.opus`/`.ogg` as voice messages, anything else as a file (at most 30 MB).
- Scheduled results and notifications are posted to the chat without quoting.
- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` in openbee's environment are honoured for API calls; the long connection itself is opened directly.

## Create the app

1. In the [Feishu developer console](https://open.feishu.cn/app) (or the [Lark developer console](https://open.larksuite.com/app)) create a **custom app** and copy the **App ID** and **App Secret** from *Credentials & Basic Info*.
2. Under *Add features*, enable **Bot**.
3. Under *Permissions & Scopes*, add:
   - `im:message` — send messages, replies and reactions
   - `im:message.p2p_msg:readonly` — receive direct messages
   - `im:message.group_at_msg:readonly` — receive group messages that @ the bot
   - `im:resource` — upload images and files and download message attachments
4. Under *Events & Callbacks*, choose **Receive events through persistent connection** as the subscription mode and add the event `im.message.receive_v1` (*Receive messages*). The console only accepts this mode while a client is connected, so start openbee with the plugin enabled first if it complains.
5. Create a version and publish it. Add the bot to the groups it should serve.

## Install

```sh
openbee plugin install @theopenbee/channel-lark
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-lark.git
cd channel-lark
npm install
openbee plugin install "$(pwd)"
```

Then enable it with `openbee config`, or add it to `config.yaml` and restart openbee. A config written for the built-in channel works unchanged:

```yaml
bee:
  platforms:
    feishu:
      enabled: true
      bot_name: OpenBee
      app_id: "cli_xxxxxxxxxxxxxxxx"
      app_secret: "<app secret>"
      max_media_size: 104857600
```

| Key | Default | |
|---|---|---|
| `app_id` | | App ID of the custom app (`cli_...`). Required. |
| `app_secret` | | App Secret of the same app. Required. |
| `max_media_size` | `104857600` | Largest attachment, in bytes, downloaded from incoming messages. |
| `domain` | `feishu` | Advanced. `feishu` (open.feishu.cn), `lark` (open.larksuite.com) or a base URL, for example a reverse proxy. |

`bot_name` should match the bot's display name in Feishu so that mentions of the bot are recognised.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The tests run offline against a local fake of the Feishu REST API and of the long connection.
