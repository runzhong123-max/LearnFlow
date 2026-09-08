"use client";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { emptyChatDraft, readChatDraft, saveChatDraft, type ChatDraft } from "@/lib/chat/workspace-state";

/** Storage and async setters are bound to the actor, project, conversation and snapshot. */
export function useConversationDraft(scope: string, storageKey?: string) {
  const [values, setValues] = useState<Record<string, ChatDraft>>({});
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const hydrated = useRef(new Set<string>());
  useEffect(() => {
    if (!storageKey || hydrated.current.has(storageKey)) return;
    hydrated.current.add(storageKey);
    const stored = readChatDraft(sessionStorage, storageKey);
    setValues((current) => current[scope] ? current : { ...current, [scope]: stored });
  }, [scope, storageKey]);
  const setDraft: Dispatch<SetStateAction<ChatDraft>> = (action) => {
    const current = valuesRef.current[scope] || emptyChatDraft;
    const next = typeof action === "function" ? action(current) : action;
    valuesRef.current = { ...valuesRef.current, [scope]: next };
    saveChatDraft(sessionStorage, storageKey, next);
    setValues(valuesRef.current);
  };
  return [values[scope] || emptyChatDraft, setDraft] as const;
}
