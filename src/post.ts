export interface MediaKeyInfo {
  fileKey: string;
  fileName: string;
}

export interface PostParseResult {
  textContent: string;
  imageKeys: string[];
  mediaKeys: MediaKeyInfo[];
}

interface PostBody {
  title: string;
  content: unknown;
  files?: unknown;
}

type JsonObject = Record<string, unknown>;

const MENTION_PREFIX = "@";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toBody(value: unknown): PostBody | undefined {
  if (value === null) return { title: "", content: undefined };
  if (!isObject(value)) return undefined;
  const title = value.title;
  if (title !== undefined && title !== null && typeof title !== "string") return undefined;
  return { title: title ?? "", content: "content" in value ? value.content : undefined, files: value.files };
}

function findLocaleBody(map: JsonObject): PostBody | undefined {
  for (const value of Object.values(map)) {
    const body = toBody(value);
    if (body && body.content !== undefined) return body;
  }
  return undefined;
}

export function parsePostContent(content: string): PostParseResult {
  if (!content) throw new Error("empty post content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`parse post JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed !== null && !isObject(parsed)) throw new Error("parse post JSON: not an object");
  const raw: JsonObject = parsed ?? {};

  if ("content" in raw) {
    const body = toBody(raw);
    if (body) return parsePostBody(body);
  }

  const locale = findLocaleBody(raw);
  if (locale) return parsePostBody(locale);

  if ("post" in raw) {
    const post = raw.post;
    if (post === null || isObject(post)) {
      const body = findLocaleBody(post ?? {});
      if (body) return parsePostBody(body);
    }
  }

  throw new Error("unrecognized post content format");
}

function paragraphElements(paragraph: unknown): JsonObject[] | undefined {
  if (paragraph === null) return [];
  if (!Array.isArray(paragraph)) return undefined;
  const elements: JsonObject[] = [];
  for (const elem of paragraph) {
    if (elem === null) {
      elements.push({});
      continue;
    }
    if (!isObject(elem)) return undefined;
    elements.push(elem);
  }
  return elements;
}

function parsePostBody(body: PostBody): PostParseResult {
  if (body.content !== null && body.content !== undefined && !Array.isArray(body.content)) {
    throw new Error("parse content paragraphs: not an array");
  }
  const paragraphs: unknown[] = Array.isArray(body.content) ? body.content : [];
  const result: PostParseResult = { textContent: "", imageKeys: [], mediaKeys: [] };
  const textParts: string[] = [];
  if (body.title) textParts.push(body.title);

  for (const paragraph of paragraphs) {
    const elements = paragraphElements(paragraph);
    if (!elements) continue;
    let paraText = "";
    for (const elem of elements) {
      switch (str(elem.tag)) {
        case "text":
          paraText += applyStyles(str(elem.text), elem);
          break;
        case "a":
          paraText += `[${str(elem.text)}](${str(elem.href)})`;
          break;
        case "at":
          paraText += MENTION_PREFIX + (str(elem.user_name) || str(elem.user_id));
          break;
        case "img": {
          const key = str(elem.image_key);
          if (key) result.imageKeys.push(key);
          break;
        }
        case "media": {
          const fileKey = str(elem.file_key);
          if (fileKey) result.mediaKeys.push({ fileKey, fileName: str(elem.file_name) });
          break;
        }
        case "code_block":
        case "pre": {
          const text = str(elem.text) || str(elem.content);
          paraText += `\n\`\`\`${str(elem.language)}\n${text}\n\`\`\`\n`;
          break;
        }
        case "code":
          paraText += "`" + str(elem.text) + "`";
          break;
        case "emotion":
          paraText += str(elem.emoji_type) || str(elem.emoji);
          break;
        case "br":
          paraText += "\n";
          break;
        case "hr":
          paraText += "\n---\n";
          break;
      }
    }
    if (paraText.length > 0) textParts.push(paraText);
  }

  if (Array.isArray(body.files)) {
    for (const file of body.files) {
      if (!isObject(file) || file.is_folder === true) continue;
      const fileKey = str(file.file_key);
      if (fileKey) result.mediaKeys.push({ fileKey, fileName: str(file.file_name) });
    }
  }

  result.textContent = textParts.join("\n");
  return result;
}

export function applyStyles(text: string, elem: JsonObject): string {
  const styles = elem.style;
  if (!Array.isArray(styles)) return text;
  for (const style of styles) {
    switch (str(style)) {
      case "bold":
        text = "**" + text + "**";
        break;
      case "italic":
        text = "*" + text + "*";
        break;
      case "code":
        text = "`" + text + "`";
        break;
      case "strikethrough":
        text = "~~" + text + "~~";
        break;
    }
  }
  return text;
}

export function buildPostContent(markdown: string): string {
  const rows = markdown.split("\n").map((line) => [{ tag: "md", text: line }]);
  return JSON.stringify({ zh_cn: { title: "", content: rows } });
}
