#!/usr/bin/env python3
"""Validate skill metadata and plugin manifests using trusted release tooling."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$")
MANIFESTS = (
    ".claude-plugin/plugin.json",
    ".github/plugin/plugin.json",
    "package.json",
    ".claude-plugin/marketplace.json",
    ".github/plugin/marketplace.json",
)


def parse_frontmatter(path):
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|\Z)", text)
    if not match:
        raise ValueError(f"{path}: missing YAML frontmatter")
    lines = match.group(1).splitlines()
    fields = {}
    metadata = {}
    active_key = None
    block_style = None
    block_lines = []

    def finish_block():
        nonlocal block_lines, block_style
        if active_key == "description" and block_style:
            separator = "\n" if block_style.startswith("|") else " "
            fields["description"] = separator.join(line.strip() for line in block_lines).strip()
        block_lines = []
        block_style = None

    for line in lines:
        top = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", line)
        nested = re.match(r"^[ \t]+([A-Za-z][\w-]*):\s*(.*)$", line)
        if top:
            finish_block()
            active_key = top.group(1)
            value = top.group(2).strip()
            if active_key == "description" and re.fullmatch(r"[>|][-+]?\d*", value):
                block_style = value
                continue
            fields[active_key] = value.strip("'\"")
        elif nested and active_key == "metadata":
            metadata[nested.group(1)] = nested.group(2).strip().strip("'\"")
        elif block_style and (line.startswith(" ") or not line.strip()):
            block_lines.append(line)
    finish_block()
    return fields, metadata


def validate(root, validator):
    skills_dir = root / "skills"
    if not skills_dir.is_dir():
        raise ValueError("skills/ directory is missing")
    skills = sorted(path for path in skills_dir.iterdir() if path.is_dir() and (path / "SKILL.md").is_file())
    if not skills:
        raise ValueError("No skill directories containing SKILL.md were found")

    versions = []
    for skill in skills:
        skill_file = skill / "SKILL.md"
        for path in skill.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"{path.relative_to(root)}: symlinks are not allowed in skill content")
        fields, metadata = parse_frontmatter(skill_file)
        name = fields.get("name", "").strip()
        description = fields.get("description", "").strip()
        version = metadata.get("version", "")
        if name != skill.name:
            raise ValueError(f"{skill_file.relative_to(root)}: name '{name or 'missing'}' must match '{skill.name}'")
        if not VERSION.fullmatch(version):
            raise ValueError(f"{skill_file.relative_to(root)}: invalid metadata.version '{version or 'missing'}'")
        subprocess.run(
            [sys.executable, str(validator), "--name", name, "--description", description],
            check=True,
        )
        versions.append((skill.name, version))

    plugin_versions = []
    marketplace_versions = []
    for relative in MANIFESTS:
        path = root / relative
        if not path.exists():
            continue
        if path.is_symlink():
            raise ValueError(f"{relative}: symlink manifests are not allowed")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError(f"{relative}: malformed JSON: {error}") from error
        if relative.endswith("marketplace.json"):
            entries = data.get("plugins")
            if not isinstance(entries, list):
                raise ValueError(f"{relative}: plugins must be an array")
            local = next((entry for entry in entries if entry.get("source") in {".", "./"}), None)
            if local:
                version = local.get("version")
                if not isinstance(version, str) or not VERSION.fullmatch(version):
                    raise ValueError(f"{relative}: local plugin version is missing or invalid")
                plugin_versions.append((relative, version))
            meta_version = data.get("metadata", {}).get("version")
            if meta_version is not None:
                if not isinstance(meta_version, str) or not VERSION.fullmatch(meta_version):
                    raise ValueError(f"{relative}: metadata.version is invalid")
                marketplace_versions.append((relative, meta_version))
        else:
            version = data.get("version")
            if not isinstance(version, str) or not VERSION.fullmatch(version):
                raise ValueError(f"{relative}: version is missing or invalid")
            plugin_versions.append((relative, version))

    distinct = {version for _, version in plugin_versions}
    if len(distinct) > 1:
        raise ValueError("Plugin version mismatch: " + ", ".join(f"{file}={version}" for file, version in plugin_versions))
    marketplace_distinct = {version for _, version in marketplace_versions}
    if len(marketplace_distinct) > 1:
        raise ValueError("Marketplace metadata versions differ: " + ", ".join(f"{file}={version}" for file, version in marketplace_versions))
    return versions, plugin_versions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--validator", required=True, type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    try:
        skills, plugins = validate(args.target.resolve(), args.validator.resolve())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Validation failed: {error}", file=sys.stderr)
        return 1
    lines = ["## Skill validation", "", f"Validated **{len(skills)}** skills and plugin manifests.", ""]
    lines.extend(f"- `{name}` — `{version}`" for name, version in skills)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        with args.summary.open("a", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
    print(f"Validated {len(skills)} skills and {len(plugins)} plugin version entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
