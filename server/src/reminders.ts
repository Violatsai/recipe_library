import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Push grocery items to Apple Reminders via osascript (JXA). The Mac runs the
 * server, Reminders syncs to the user's iPhone through iCloud — no accounts or
 * keys needed. The target list is app-owned and WIPED on every send (so
 * resending replaces rather than duplicates); a distinct name keeps us away
 * from any list the user made themselves.
 *
 * First use triggers a macOS automation-permission prompt (node → Reminders);
 * a denial surfaces as error -1743, which we translate for the UI.
 */

export const REMINDERS_LIST_NAME = "Recipe Library Groceries";

export interface ReminderItem {
  title: string;
  section: string;
}

// JXA program: argv[0] is a JSON payload { listName, items: [{title, section}] }.
const JXA = `
function run(argv) {
  const payload = JSON.parse(argv[0]);
  const app = Application("Reminders");
  const matches = app.lists.whose({ name: payload.listName })();
  let list;
  if (matches.length > 0) {
    list = matches[0];
    const existing = list.reminders();
    for (let i = existing.length - 1; i >= 0; i--) {
      app.delete(existing[i]);
    }
  } else {
    list = app.List({ name: payload.listName });
    app.lists.push(list);
  }
  for (const item of payload.items) {
    list.reminders.push(app.Reminder({ name: item.title, body: item.section }));
  }
  return "ok:" + payload.items.length;
}
`;

export async function sendToReminders(items: ReminderItem[]): Promise<number> {
  const payload = JSON.stringify({ listName: REMINDERS_LIST_NAME, items });
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", JXA, "--", payload],
      { timeout: 45_000 },
    );
    if (!stdout.trim().startsWith("ok:")) {
      throw new Error(`unexpected osascript output: ${stdout.trim()}`);
    }
    return items.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("-1743")) {
      throw new Error(
        "macOS blocked automation access to Reminders. Approve it in System Settings → Privacy & Security → Automation, then try again.",
      );
    }
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
      throw new Error(
        "Reminders did not respond — if a permission dialog is open on the Mac, click Allow and try again.",
      );
    }
    throw new Error(`could not reach Reminders: ${msg}`);
  }
}
