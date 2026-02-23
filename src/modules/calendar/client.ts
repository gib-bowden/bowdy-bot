import { google } from "googleapis";
import { config } from "../../config.js";
import { getAuthClient } from "../../auth/google.js";

export async function getCalendarClient() {
  const auth = await getAuthClient();
  return google.calendar({ version: "v3", auth });
}

export function getCalendarId(): string {
  return config.googleCalendarId;
}
