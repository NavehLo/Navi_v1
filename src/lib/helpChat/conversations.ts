import type { HelpActionId } from './actions';
import type { HelpPlaceId } from './places';

// The help chat's conversations, on the device only: the one under way and the
// five before it ("היסטוריה"). Nothing here is sent anywhere — the server keeps
// its own log of questions, without who asked (help_chat_log).

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  actions?: HelpActionId[];
  // The button the answer talks about, for "הראה לי איפה".
  pointTo?: HelpPlaceId | null;
  // A note from the app itself (busy, limit…), not sent back to the model.
  note?: boolean;
}

export interface Conversation {
  id: string;
  // Last message, for the history list and for starting afresh after a while.
  at: number;
  messages: ChatMessage[];
}

export interface ChatStore {
  current: Conversation;
  past: Conversation[];
}

const KEY = 'navi:helpChat.v1';
const PAST = 5;
// Coming back to the chat after this long starts a new conversation; the old
// one is in the history.
const STALE_MS = 6 * 60 * 60 * 1000;

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const emptyConversation = (): Conversation => ({ id: newId(), at: Date.now(), messages: [] });

// The conversation goes into the history only if something was asked in it.
function archive(past: Conversation[], c: Conversation): Conversation[] {
  if (!c.messages.length) return past;
  return [c, ...past.filter((p) => p.id !== c.id)].slice(0, PAST);
}

export function loadChat(): ChatStore {
  let store: ChatStore = { current: emptyConversation(), past: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as ChatStore;
      if (s?.current && Array.isArray(s.past)) store = s;
    }
  } catch {}
  if (store.current.messages.length && Date.now() - store.current.at > STALE_MS) {
    store = { current: emptyConversation(), past: archive(store.past, store.current) };
  }
  return store;
}

export function saveChat(store: ChatStore) {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {}
}

export function startNew(store: ChatStore): ChatStore {
  if (!store.current.messages.length) return store;
  return { current: emptyConversation(), past: archive(store.past, store.current) };
}

export function reopen(store: ChatStore, id: string): ChatStore {
  const picked = store.past.find((c) => c.id === id);
  if (!picked) return store;
  return { current: picked, past: archive(store.past.filter((c) => c.id !== id), store.current) };
}
