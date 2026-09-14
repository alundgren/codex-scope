import { randomUUID } from "node:crypto";
import { privateText } from "./connection.ts";
import { savePrivatePreferences } from "./preferences.ts";
import {
  validPromptOverrides,
  validPromptId,
  validPromptText,
  type PromptOverrides,
  type PromptEdit,
} from "./review-prompts.ts";
export const PROMPT_PREFERENCES_BYTES = 128 * 1024;
export async function loadPromptPreferences(file: string): Promise<PromptOverrides> {
  try {
    const value = JSON.parse(await privateText(file, PROMPT_PREFERENCES_BYTES));
    if (
      !value ||
      value.version !== 1 ||
      Object.keys(value).length !== 2 ||
      !validPromptOverrides(value.overrides)
    )
      throw Error("Invalid prompt preferences.");
    return value.overrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw Error(
      "Saved prompts could not be read. Check the private prompt settings file and restart Scope.",
    );
  }
}
export async function savePromptPreferences(
  file: string,
  previous: PromptOverrides,
  edit: PromptEdit,
): Promise<PromptOverrides> {
  if (
    !edit ||
    Object.keys(edit).length !== 2 ||
    !validPromptId(edit.id) ||
    (edit.text !== null && !validPromptText(edit.text))
  )
    throw Error("Enter a nonempty prompt of at most 8 KiB without control characters.");
  const overrides = { ...previous };
  if (edit.text === null) delete overrides[edit.id];
  else overrides[edit.id] = { text: edit.text, version: randomUUID() };
  if (!validPromptOverrides(overrides)) throw Error("Invalid prompt preferences.");
  await savePrivatePreferences(
    file,
    JSON.stringify({ version: 1, overrides }) + "\n",
    PROMPT_PREFERENCES_BYTES,
    ".prompt-preferences.tmp",
  );
  return overrides;
}
