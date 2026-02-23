import { google } from "googleapis";
import { getAuthClient } from "../../auth/google.js";

export async function getTasksClient() {
  const auth = await getAuthClient();
  return google.tasks({ version: "v1", auth });
}
