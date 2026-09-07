import assert from "node:assert/strict";
import test from "node:test";
import { updateConversationValue } from "../lib/skills/workspace";

test("late stream events and completion update only their originating conversation", () => {
  type Chat = { text: string; running: boolean };
  const initial: Chat = { text: "", running: false };
  let state: Record<string, Chat> = {};
  const capture = (id: string) => (update: (value: Chat) => Chat) => { state = updateConversationValue(state, id, initial, update); };
  const streamA = capture("conversation-a");
  streamA(() => ({ text: "A first", running: true }));
  const streamB = capture("conversation-b");
  streamB(() => ({ text: "B first", running: true }));
  const b = state["conversation-b"];
  streamA((current) => ({ ...current, text: current.text + " last", running: false }));
  assert.deepEqual(state["conversation-a"], { text: "A first last", running: false });
  assert.equal(state["conversation-b"], b);
  assert.deepEqual(state["conversation-b"], { text: "B first", running: true });
  assert.deepEqual(initial, { text: "", running: false });
});

test("new conversation drafts begin empty while existing drafts survive switching", () => {
  let drafts = updateConversationValue<string>({}, "first", "", "unfinished question");
  drafts = updateConversationValue(drafts, "second", "", (draft) => draft + "another question");
  assert.equal(drafts.first, "unfinished question");
  assert.equal(drafts.second, "another question");
  assert.equal(drafts.third, undefined);
});
