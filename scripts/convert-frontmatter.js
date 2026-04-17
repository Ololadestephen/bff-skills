#!/usr/bin/env node

/**
 * convert-frontmatter.js
 *
 * Converts bff-skills SKILL.md frontmatter format to aibtcdev/skills format.
 *
 * bff-skills format (flat):
 *   ---
 *   name: my-skill
 *   description: Does things
 *   author: someone
 *   author_agent: Some Agent
 *   user-invocable: true
 *   arguments: doctor | run
 *   entry: my-skill/my-skill.ts
 *   requires: [wallet, signing]
 *   tags: [defi, write]
 *   ---
 *
 * aibtcdev/skills format (nested metadata):
 *   ---
 *   name: my-skill
 *   description: Does things
 *   metadata:
 *     user-invocable: "false"
 *     arguments: "doctor | run"
 *     entry: "my-skill/my-skill.ts"
 *     requires: "wallet, signing"
 *     tags: "defi, write"
 *     author: "someone"
 *     author-agent: "Some Agent"
 *   ---
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node convert-frontmatter.js <path-to-SKILL.md>');
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf-8');

// Split frontmatter from body
const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
if (!fmMatch) {
  console.error('No valid YAML frontmatter found');
  process.exit(1);
}

const frontmatterRaw = fmMatch[1];
const body = fmMatch[2];

// Skip if already in AIBTC format (has nested metadata: block)
if (/^\s*metadata:\s*$/m.test(frontmatterRaw)) {
  console.log(`⏭️  Already in AIBTC format, skipping: ${path.basename(filePath)}`);
  process.exit(0);
}

// Parse frontmatter lines into key-value pairs
const fields = {};
for (const line of frontmatterRaw.split('\n')) {
  const match = line.match(/^(\S+):\s*(.*)$/);
  if (match) {
    const key = match[1].trim();
    let value = match[2].trim();

    // Handle YAML arrays like [wallet, signing] -> "wallet, signing"
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).trim();
    }

    // Remove quotes if already quoted
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    fields[key] = value;
  }
}

// Fields that stay at top level in aibtcdev format
const topLevelFields = ['name', 'description'];

// Fields that go under metadata: (with key remapping)
const metadataKeyMap = {
  'author': 'author',
  'author_agent': 'author-agent',
  'author-agent': 'author-agent',
  'user-invocable': 'user-invocable',
  'arguments': 'arguments',
  'entry': 'entry',
  'requires': 'requires',
  'tags': 'tags',
};

// Build the new frontmatter
let newFrontmatter = '---\n';

// Top-level fields
for (const key of topLevelFields) {
  if (fields[key]) {
    newFrontmatter += `${key}: ${fields[key]}\n`;
  }
}

// Metadata block
newFrontmatter += 'metadata:\n';

// user-invocable is always "false" in aibtcdev convention
// (Claude Code invokes skills, not users directly)
newFrontmatter += `  user-invocable: "false"\n`;

// Rest of metadata fields
const metadataOrder = ['arguments', 'entry', 'requires', 'tags', 'author', 'author_agent', 'author-agent'];
const written = new Set(['user-invocable']);

for (const srcKey of metadataOrder) {
  const destKey = metadataKeyMap[srcKey];
  if (destKey && fields[srcKey] && !written.has(destKey)) {
    newFrontmatter += `  ${destKey}: "${fields[srcKey]}"\n`;
    written.add(destKey);
  }
}

// Catch any remaining fields not in top-level or metadata map
for (const [key, value] of Object.entries(fields)) {
  if (!topLevelFields.includes(key) && !written.has(metadataKeyMap[key] || key) && !written.has(key)) {
    const destKey = metadataKeyMap[key] || key;
    newFrontmatter += `  ${destKey}: "${value}"\n`;
    written.add(destKey);
  }
}

newFrontmatter += '---\n';

// Write back
const newContent = newFrontmatter + body;
fs.writeFileSync(filePath, newContent, 'utf-8');

console.log(`✅ Converted frontmatter for: ${path.basename(filePath)}`);
console.log('--- New frontmatter ---');
console.log(newFrontmatter);
