import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  transport: {
    target: "pino/file",
    options: { destination: 2 }, // stderr so it doesn't mix with console chat
  },
});
