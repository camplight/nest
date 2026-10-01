import { useState } from "react";
import "./agent-avatar.css";

// Figma's original character identities. This is presentation only: it never
// changes an agent's name, role, instructions, or engine configuration.
const characters = ["puff", "moss", "muff", "pom", "pip"] as const;
type Character = typeof characters[number];
const aliases: Record<string, Character> = {
  strategy: "puff", strategist: "puff",
  research: "moss", researcher: "moss",
  product: "muff",
  design: "pom", designer: "pom",
  engineering: "pip", engineer: "pip", developer: "pip", builder: "pip", nestsystem: "pip",
};

export function agentCharacter(name: string): Character {
  const normalized = name.trim().toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/);
  // Named characters take precedence over role-like names.
  const named = characters.find(character => words.includes(character));
  if (named) return named;
  const role = words.find(word => Object.hasOwn(aliases, word));
  if (role) return aliases[role];
  // Stable across list ordering, views, sessions and machines. No random avatars.
  let hash = 2166136261;
  for (const char of normalized) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return characters[hash % characters.length];
}

export function AgentAvatar({ name, size = 48 }: { name: string; size?: number }) {
  const character = agentCharacter(name);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const src = `${import.meta.env.BASE_URL}design/avatars/${character}.png`;
  // Adjacent UI supplies the agent's accessible name; the portrait is decorative.
  return <span className="agent-portrait" aria-hidden="true" style={{ width: size, height: size }}>
    {failedSource === src ? <span>{name.trim().slice(0, 2).toUpperCase() || "AI"}</span> :
      <img src={src} width={size} height={size} alt="" decoding="async" onError={() => setFailedSource(src)} />}
  </span>;
}
