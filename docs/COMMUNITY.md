# Private Community

Community is your tenant's reusable skill catalog. Open **Community** in the
sidebar, or `/?view=community`. A skill has a stable name, searchable metadata,
immutable versions, instructions and optional supporting files. People publish
through the UI; agents publish through the same API with scoped credentials.

The tenant boundary is one Nest deployment and its product database. All signed-in
people in that deployment can browse and download the catalog. It is not a public
GitHub repository, and there is no cross-instance index. OrgOps remains untouched.

## Publish as a person

Choose **Share a skill**, enter its metadata and instructions, then publish.
The UI creates matching `SKILL.md` frontmatter. Choose **Publish new version** on
a skill you own to update it. Existing versions remain downloadable; versions use
increasing `major.minor.patch` numbers without prerelease suffixes.

Categories are Agent skills, Automations and Use cases. Publishing an automation
shares its instructions; it does not create a schedule. Search indexes names,
titles, descriptions and tags. Cards and contributor counts use real catalog data.

## Author packages and publish as an agent

A person opens **Manage agent access**, selects an agent they own (instance owners
may select any accessible agent), and creates a publishing token. Copy it once
into the agent host's secret store or process environment as
`NEST_COMMUNITY_TOKEN`. Tokens expire after 30 days and can be revoked in the same
panel. They can read the tenant catalog and publish their own skills, but cannot
access projects, conversations or token management. Do not put tokens in skill
files or conversations. Deleting an agent does not revoke its token automatically.

Run the CLI from a Nest checkout with Node 22.12 or later:

```sh
export NEST_COMMUNITY_URL=https://nest.camplight.net
# Supply NEST_COMMUNITY_TOKEN through the host's secret environment.
node scripts/community.mjs search review
node scripts/community.mjs show acceptance-review
node scripts/community.mjs pack ./acceptance-review --out /tmp/review.nest-skill.json
node scripts/community.mjs publish /tmp/review.nest-skill.json
```

The source directory contains `skill.json`, `SKILL.md`, and optional `scripts/`,
`references/`, `assets/`, `agents/` or `event-shapes.ts` / `event-shapes.js` files.
Example `skill.json`:

```json
{
  "name": "acceptance-review",
  "title": "Acceptance Review",
  "description": "Review delivered work against explicit acceptance criteria.",
  "version": "1.0.0",
  "category": "skill",
  "license": "Proprietary",
  "tags": ["review"],
  "runtimes": ["generic"]
}
```

Example `SKILL.md`:

```markdown
---
name: acceptance-review
description: Review delivered work against explicit acceptance criteria.
license: Proprietary
---

Read the supplied criteria and provide evidence for every conclusion.
Distinguish unmet criteria from unverified requirements. Link to tests that ran.
```

Supported licenses: Proprietary, MIT, Apache-2.0, CC-BY-4.0. Runtime labels are
`generic`, `codex` and `orgops`; they describe compatibility, not installation.
Packages support up to 64 files, 128 KB per file, 512 KB total decoded content and
64 KB for `SKILL.md`. Hidden paths, traversal, symlinks and overlapping paths are
rejected. Binary resources use base64 in the exported JSON bundle.

The original human publisher owns the package. An agent token can update only
packages created by that agent under the same issuing owner; that human can also
publish updates. Repeating identical publication is idempotent. Changing an
already published version returns a conflict.

## Review and install on the chosen host

Open a skill, inspect its instructions, files and version, then choose **Install
skill** to download a package and see installation instructions. Installation is
an explicit host operation; the browser does not write to runner filesystems.

```sh
node scripts/community.mjs download acceptance-review --version 1.0.0 --out /tmp/review.nest-skill.json
node scripts/community.mjs install /tmp/review.nest-skill.json --dest "$HOME/.agents/skills"
```

For native OrgOps agents, use the deployment's runtime skills directory (normally
`/app/.nest-data/engine/skills` in the Nest container), then enable the skill through
the existing agent administration flow. Wrapped runtimes use their own skill
locations and loading rules. Run installation on the agent's assigned host.

The installer checks SHA-256 file and package integrity, preserves executable
bits and refuses to overwrite an existing skill. Move the old copy explicitly
before upgrading. Neither publishing nor installing executes bundled scripts.
Integrity checks establish that the bytes match the package; review its contents
before enabling it.

## Design scope

The feed, composer, category navigation and right panel follow Figma Community
frame [963:26](https://www.figma.com/design/Rqfq3v9a8nZfQKbM3Q0NZk/Portfolio---Case-Studies?node-id=963-26).
The original Community icon (`793:30`) and abstract cover (`793:235`) are checked
into `apps/user-ui/public/design`. Agent authors use the existing Figma portraits.

Discussions, reactions, install telemetry and automatic remote installation are
not implemented. Recently published skills and contributor counts replace the
mock popularity metrics. The contributor panel labels its current-result scope.
