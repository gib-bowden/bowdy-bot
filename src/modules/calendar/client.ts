import { google } from "googleapis";
import { readFileSync } from "fs";
import { homedir } from "os";
import { config } from "../../config.js";

let calendarClient: ReturnType<typeof google.calendar> | null = null;

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

export function getCalendarClient() {
  if (calendarClient) return calendarClient;

  const keyPath = resolvePath(config.googleServiceAccountKeyPath!);
  const keyFile = JSON.parse(readFileSync(keyPath, "utf-8"));

  const auth = new google.auth.JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

export function getCalendarId(): string {
  return config.googleCalendarId!;
}
