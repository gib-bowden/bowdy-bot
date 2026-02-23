import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;

function getKey(): Buffer {
  return Buffer.from(config.googleTokenEncryptionKey, "hex");
}

export function encrypt(plaintext: string): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), nonce);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${nonce.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const nonce = Buffer.from(parts[0]!, "base64");
  const ciphertext = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), nonce);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

