"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Sender = "You" | "ChatGPT" | "Muse";
interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
  createdAt: string;
  source: string;
}

const ROOM_KEY_STORAGE = "threeway-room-key"; // session only — never the message store

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function Home() {
  const [roomKey, setRoomKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [storageMode, setStorageMode] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRoomKey(sessionStorage.getItem(ROOM_KEY_STORAGE));
  }, []);

  const fetchMessages = useCallback(async (key: string) => {
    const res = await fetch("/api/messages?limit=100", {
      headers: { "x-room-key": key },
    });
    if (!res.ok) throw new Error(res.status === 401 ? "Wrong room key." : "Could not load messages.");
    const data = (await res.json()) as { messages: ChatMessage[] };
    setMessages(data.messages);
    setConnected(true);
    setLastSync(new Date().toLocaleTimeString());
    return data.messages;
  }, []);

  useEffect(() => {
    if (!roomKey) return;
    let stopped = false;
    const load = () => {
      fetchMessages(roomKey)
        .then(() => {
          fetch("/api/room", { headers: { "x-room-key": roomKey } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => d && setStorageMode(d.storageMode as string))
            .catch(() => undefined);
        })
        .catch((e: Error) => {
          if (!stopped) {
            setConnected(false);
            setError(e.message);
          }
        });
    };
    load();
    const t = setInterval(load, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [roomKey, fetchMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function enterRoom(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const key = keyInput.trim();
    if (!key) return;
    try {
      await fetchMessages(key);
      sessionStorage.setItem(ROOM_KEY_STORAGE, key);
      setRoomKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enter the room.");
    }
  }

  async function send() {
    if (!roomKey || !input.trim() || sending) return;
    setSending(true);
    setError(null);
    const text = input.trim();
    setInput("");
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-room-key": roomKey },
        body: JSON.stringify({ sender: "You", text }),
      });
      if (!res.ok) throw new Error("Send failed. Please try again.");
      await fetchMessages(roomKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!roomKey) {
    return (
      <main className="container">
        <div className="gate">
          <h1>Threeway</h1>
          <p className="sub">One shared room for You, ChatGPT and Muse.</p>
          <form onSubmit={enterRoom}>
            <label htmlFor="room-key">Room key</label>
            <input
              id="room-key"
              type="password"
              autoComplete="off"
              placeholder="Enter the room key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button className="send" type="submit" style={{ width: "100%", padding: "10px" }}>
              Enter room
            </button>
          </form>
          {error ? <p className="error">{error}</p> : null}
          <p className="sub">The room key is in the server environment (ROOM_KEY). It is not stored in the message history.</p>
        </div>
      </main>
    );
  }

  const lastBy = (s: Sender) => [...messages].reverse().find((m) => m.sender === s);

  return (
    <main className="container">
      <header>
        <div>
          <h1>Threeway</h1>
          <p className="sub">
            {connected ? "Connected" : "Reconnecting…"}
            {lastSync ? ` · synced ${lastSync}` : ""}
            {storageMode ? ` · storage: ${storageMode}` : ""}
          </p>
        </div>
        <div className="participants">
          <span className="chip"><span className="dot dot-you" /> You <span className="dot dot-online" /></span>
          <span className="chip"><span className="dot dot-gpt" /> ChatGPT</span>
          <span className="chip"><span className="dot dot-muse" /> Muse</span>
        </div>
      </header>

      <div className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty">No messages yet. Say hello — ChatGPT and Muse will see it here too.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.sender}`}>
              <div className="meta">
                <strong>{m.sender}</strong>
                <span>{fmtTime(m.createdAt)}</span>
                <span>{m.source}</span>
              </div>
              <div className="text">{m.text}</div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <p className="status">
        ChatGPT last: {lastBy("ChatGPT") ? fmtTime(lastBy("ChatGPT")!.createdAt) : "—"} · Muse last:{" "}
        {lastBy("Muse") ? fmtTime(lastBy("Muse")!.createdAt) : "—"}
      </p>

      {error ? <p className="error">{error}</p> : null}
      <div className="composer">
        <textarea
          aria-label="Message"
          placeholder="Message You, ChatGPT and Muse… (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="send" onClick={() => void send()} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </main>
  );
}
