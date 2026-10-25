import { defineChannel } from "@theopenbee/channel-sdk";

import { createFeishuChannel } from "./feishu.js";

defineChannel(createFeishuChannel());
