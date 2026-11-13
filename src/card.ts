import type { Button } from "@theopenbee/channel-sdk";

type JsonObject = Record<string, unknown>;

export interface CardAction {
  label: string;
  text: string;
  scope: string;
  chatType: string;
}

export interface CardActionEvent {
  operator?: { open_id?: string | null; union_id?: string | null } | null;
  action?: { value?: unknown } | null;
  context?: { open_message_id?: string | null; open_chat_id?: string | null } | null;
  open_message_id?: string | null;
  open_chat_id?: string | null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function card(elements: JsonObject[]): JsonObject {
  return { schema: "2.0", config: { update_multi: true }, body: { elements } };
}

export function buildButtonCard(markdown: string, buttons: Button[], scope: string, chatType: string): JsonObject {
  const columns = buttons.map((b) => ({
    tag: "column",
    width: "auto",
    elements: [
      {
        tag: "button",
        text: { tag: "plain_text", content: b.label },
        type: b.style === "danger" ? "danger" : "default",
        behaviors: [{ type: "callback", value: { openbee: 1, label: b.label, text: b.text, scope, chat_type: chatType } }],
      },
    ],
  }));
  return card([
    { tag: "markdown", content: markdown },
    { tag: "column_set", flex_mode: "flow", horizontal_spacing: "8px", columns },
  ]);
}

export function buildAnsweredCard(markdown: string, note: string): JsonObject {
  return card([
    { tag: "markdown", content: markdown },
    { tag: "div", text: { tag: "plain_text", content: note, text_color: "grey", text_size: "notation" } },
  ]);
}

export function parseCardAction(value: unknown): CardAction | undefined {
  if (!isObject(value) || value.openbee !== 1) return undefined;
  const { label, text, scope, chat_type } = value;
  if (typeof label !== "string" || typeof text !== "string" || typeof scope !== "string" || typeof chat_type !== "string") return undefined;
  if (!label || !text || !scope) return undefined;
  return { label, text, scope, chatType: chat_type };
}

export function selectedNote(language: string, label: string): string {
  return language === "zh" ? `已选择：${label}` : `Selected: ${label}`;
}

export function notOwnerText(language: string): string {
  return language === "zh" ? "只有发起人可以选择" : "Only the person who asked can choose";
}
