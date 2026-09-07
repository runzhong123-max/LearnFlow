"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { updateConversationValue } from "@/lib/skills/workspace";

/** Async callbacks capture their originating conversation key, never the visible chat. */
export function useConversationState<T>(conversationId: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [values, setValues] = useState<Record<string, T>>({});
  const key = conversationId || "local:bundled-role-package";
  const setValue: Dispatch<SetStateAction<T>> = (action) => setValues((current) => updateConversationValue(current, key, initial, action));
  return [values[key] ?? initial, setValue];
}
