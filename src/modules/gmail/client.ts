import { google } from "googleapis";
import { getAuthClient } from "../../auth/google.js";

export async function getGmailClient(email?: string) {
  const auth = await getAuthClient(email);
  return google.gmail({ version: "v1", auth });
}
