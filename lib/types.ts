export const SENDERS = ["You", "ChatGPT", "Muse"] as const;
export type Sender = (typeof SENDERS)[number];

export interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
  createdAt: string; // ISO 8601
  source: "web" | "api" | "mcp";
}

export interface RoomInfo {
  name: string;
  participants: { name: Sender; role: string; status: string }[];
  messageCount: number;
  storageMode: "blob" | "file";
  updatedAt: string | null;
}

export const MAX_TEXT_LENGTH = 2000;
export const MAX_MESSAGES = 500;
