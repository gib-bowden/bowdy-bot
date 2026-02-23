import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaSkillParams } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { getClient } from "../ai/client.js";
import { logger } from "../logger.js";

const SKILLS_DIR = resolve(import.meta.dirname, "../../skills");
const CACHE_PATH = resolve(SKILLS_DIR, ".skills-cache.json");
const DISPLAY_PREFIX = "bowdy-bot/";
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["skills-2025-10-02"];

interface LocalSkill {
  name: string;
  dirName: string;
  content: string;
}

interface SkillCacheEntry {
  hash: string;
  skillId: string;
  version?: string;
}

type SkillCache = Record<string, SkillCacheEntry>;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function loadCache(): Promise<SkillCache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveCache(cache: SkillCache): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function parseFrontmatterName(content: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const nameMatch = match[1]!.match(/^name:\s*(.+)$/m);
  return nameMatch?.[1]?.trim();
}

async function loadLocalSkills(): Promise<LocalSkill[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: LocalSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = resolve(SKILLS_DIR, entry.name, "SKILL.md");
    try {
      const content = await readFile(skillMdPath, "utf-8");
      const name = parseFrontmatterName(content) || entry.name;
      skills.push({ name, dirName: entry.name, content });
    } catch {
      logger.warn({ dir: entry.name }, "Skill directory missing SKILL.md, skipping");
    }
  }

  return skills;
}

export async function syncSkills(): Promise<BetaSkillParams[]> {
  const client = getClient();
  const localSkills = await loadLocalSkills();

  if (localSkills.length === 0) {
    logger.info("No local skills found");
    return [];
  }

  const cache = await loadCache();

  // Fetch existing remote skills (scoped by our prefix)
  const remoteSkills: Anthropic.Beta.Skills.SkillListResponse[] = [];
  for await (const skill of client.beta.skills.list({ source: "custom", betas: BETAS })) {
    if (skill.display_title && skill.display_title.startsWith(DISPLAY_PREFIX)) {
      remoteSkills.push(skill);
    }
  }

  const skillParams: BetaSkillParams[] = [];
  let cacheChanged = false;

  for (const local of localSkills) {
    const displayTitle = `${DISPLAY_PREFIX}${local.name}`;
    const contentHash = hashContent(local.content);
    const cached = cache[local.name];

    // Skip upload if content hasn't changed and remote skill still exists
    if (cached && cached.hash === contentHash) {
      const stillExists = remoteSkills.some((r) => r.id === cached.skillId);
      if (stillExists) {
        logger.debug({ skill: local.name }, "Skill unchanged, skipping upload");
        skillParams.push({
          skill_id: cached.skillId,
          type: "custom",
          ...(cached.version ? { version: cached.version } : {}),
        });
        continue;
      }
    }

    const existing = remoteSkills.find((r) => r.display_title === displayTitle);

    const file = new File([new TextEncoder().encode(local.content)], `${local.dirName}/SKILL.md`, {
      type: "text/markdown",
    });

    if (existing) {
      const version = await client.beta.skills.versions.create(existing.id, {
        files: [file],
        betas: BETAS,
      });
      const versionStr = String(version.version);
      logger.info({ skill: local.name, version: versionStr }, "Updated skill version");
      skillParams.push({
        skill_id: existing.id,
        type: "custom",
        version: versionStr,
      });
      cache[local.name] = { hash: contentHash, skillId: existing.id, version: versionStr };
    } else {
      const skill = await client.beta.skills.create({
        display_title: displayTitle,
        files: [file],
        betas: BETAS,
      });
      logger.info({ skill: local.name, id: skill.id }, "Created new skill");
      skillParams.push({
        skill_id: skill.id,
        type: "custom",
      });
      cache[local.name] = { hash: contentHash, skillId: skill.id };
    }
    cacheChanged = true;
  }

  if (cacheChanged) {
    await saveCache(cache);
  }

  logger.info({ count: skillParams.length }, "Skills synced");
  return skillParams;
}
