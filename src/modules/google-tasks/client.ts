import { google } from "googleapis";
import { readFileSync } from "fs";
import { homedir } from "os";
import { config } from "../../config.js";

let tasksClient: ReturnType<typeof google.tasks> | null = null;

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

export function getTasksClient() {
  if (tasksClient) return tasksClient;

  const keyPath = resolvePath(config.googleServiceAccountKeyPath!);
  const keyFile = JSON.parse(readFileSync(keyPath, "utf-8"));

  const auth = new google.auth.JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ["https://www.googleapis.com/auth/tasks"],
  });

  tasksClient = google.tasks({ version: "v1", auth });
  return tasksClient;
}
