#!/usr/bin/env python3
"""Render event research JSON into a structured Markdown file tree."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


LINK_KINDS = [
    "official",
    "speaker",
    "material",
    "recording",
    "repository",
    "social",
    "sponsor",
    "other",
]


def as_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    return [value]


def text(value: Any, default: str = "Unknown") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        stripped = value.strip()
        return stripped if stripped else default
    return str(value)


def slugify(value: Any, fallback: str = "item") -> str:
    raw = text(value, fallback).lower()
    normalized = unicodedata.normalize("NFKD", raw)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return slug or fallback


def unique_slug(base: str, used: set[str]) -> str:
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}-{index}"
        index += 1
    used.add(candidate)
    return candidate


def md_link(label: Any, url: Any) -> str:
    label_text = text(label, "Link")
    url_text = text(url, "")
    if not url_text or url_text == "Unknown":
        return label_text
    return f"[{label_text}]({url_text})"


def table_cell(value: Any) -> str:
    return text(value).replace("\n", " ").replace("|", "\\|")


def bullet_list(items: list[Any], empty: str = "Unknown") -> str:
    values = [text(item) for item in items if text(item, "") != ""]
    if not values:
        return f"- {empty}"
    return "\n".join(f"- {value}" for value in values)


def linked_bullet(item: Any) -> str:
    if isinstance(item, dict):
        title = text(item.get("title") or item.get("organization") or item.get("role"), "Untitled")
        url = item.get("url")
        label = md_link(title, url) if url else title
        details = []
        for key in ["period", "role", "organization", "date", "description", "summary"]:
            value = text(item.get(key), "")
            if value and value != title:
                details.append(value)
        return f"{label}" + (f" - {'; '.join(details)}" if details else "")
    return text(item)


def rich_bullet_list(items: list[Any], empty: str = "Not found in sources") -> str:
    values = [linked_bullet(item) for item in items if text(item, "") != ""]
    if not values:
        return f"- {empty}"
    return "\n".join(f"- {value}" for value in values)


def table_row(values: list[Any]) -> str:
    return "| " + " | ".join(table_cell(value) for value in values) + " |"


def write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def normalize_link(link: Any) -> dict[str, Any]:
    if isinstance(link, str):
        return {"label": link, "url": link, "kind": "other"}
    if isinstance(link, dict):
        return link
    return {"label": text(link), "url": "", "kind": "other"}


def normalize_source(source: Any) -> dict[str, Any]:
    if isinstance(source, str):
        return {
            "title": source,
            "url": source,
            "retrieved_at": "",
            "kind": "other",
            "confidence": "unknown",
            "notes": "",
        }
    if isinstance(source, dict):
        return source
    return {"title": text(source), "url": "", "kind": "other"}


def render_event_facts(event: dict[str, Any]) -> str:
    rows = [
        ("Type", event.get("event_type")),
        ("Status", event.get("status")),
        ("Official URL", event.get("official_url")),
        ("Organizer", event.get("organizer")),
        ("Date", event.get("date")),
        ("Start", event.get("start_time")),
        ("End", event.get("end_time")),
        ("Timezone", event.get("timezone")),
        ("Venue", event.get("venue_name")),
        ("Address", event.get("address")),
        ("Online access", event.get("online_url")),
        ("Registration", event.get("registration_url")),
        ("Capacity", event.get("capacity")),
        ("Deadline", event.get("deadline")),
        ("Code of conduct", event.get("code_of_conduct")),
    ]
    lines = ["| Field | Value |", "| --- | --- |"]
    lines.extend(table_row([label, value]) for label, value in rows if text(value, "") != "")
    return "\n".join(lines) if len(lines) > 2 else "Unknown"


def render_agenda(agenda: list[Any]) -> str:
    if not agenda:
        return "No timetable found in sources."
    lines = [
        "| Start | End | Session | Speakers | Track | Details |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in agenda:
        if not isinstance(item, dict):
            lines.append(table_row(["", "", item, "", "", ""]))
            continue
        speakers = ", ".join(text(name) for name in as_list(item.get("speaker_names")))
        materials = ", ".join(text(material) for material in as_list(item.get("materials")))
        details = text(item.get("description"), "")
        if materials:
            details = f"{details} Materials: {materials}".strip()
        lines.append(
            table_row(
                [
                    item.get("start"),
                    item.get("end"),
                    item.get("title"),
                    speakers,
                    item.get("track"),
                    details,
                ]
            )
        )
    return "\n".join(lines)


def render_event_markdown(data: dict[str, Any], speaker_slugs: dict[str, str]) -> str:
    event = data.get("event") if isinstance(data.get("event"), dict) else {}
    title = text(event.get("title"), "Untitled Event")
    speakers = [item for item in as_list(data.get("speakers")) if isinstance(item, dict)]
    speaker_lines = []
    for speaker in speakers:
        name = text(speaker.get("name"), "Unknown Speaker")
        slug = speaker_slugs.get(name, slugify(name, "speaker"))
        headline = text(speaker.get("headline"), "")
        affiliation = text(speaker.get("affiliation"), "")
        role = text(speaker.get("role"), "")
        focus = ", ".join(text(item) for item in as_list(speaker.get("technical_focus"))[:3])
        relevance = text(speaker.get("event_relevance"), "")
        detail = " / ".join(part for part in [headline, role, affiliation] if part)
        if focus:
            detail = f"{detail}; focus: {focus}" if detail else f"focus: {focus}"
        if relevance:
            detail = f"{detail}; relevance: {relevance}" if detail else f"relevance: {relevance}"
        speaker_lines.append(f"- [{name}](speakers/{slug}.md)" + (f" - {detail}" if detail else ""))

    checklist = []
    checklist.extend(f"Prerequisite: {text(item)}" for item in as_list(event.get("prerequisites")))
    checklist.extend(f"Bring: {text(item)}" for item in as_list(event.get("bring_items")))
    checklist.extend(f"Check-in: {text(item)}" for item in as_list(event.get("check_in")))
    checklist.extend(f"Contact: {text(item)}" for item in as_list(event.get("contact")))

    source_notes = []
    for source in as_list(data.get("sources")):
        item = normalize_source(source)
        label = md_link(item.get("title") or item.get("url"), item.get("url"))
        confidence = text(item.get("confidence"), "")
        note = text(item.get("notes"), "")
        suffix = " - ".join(part for part in [confidence, note] if part)
        source_notes.append(f"- {label}" + (f" - {suffix}" if suffix else ""))

    sections = [
        f"# {title}",
        "## Summary",
        text(event.get("summary"), text(event.get("description"), "No summary found in sources.")),
        "## Event Facts",
        render_event_facts(event),
        "## Timetable",
        render_agenda(as_list(data.get("agenda"))),
        "## Speakers",
        "\n".join(speaker_lines) if speaker_lines else "No speakers found in sources.",
        "## Attendee Checklist",
        bullet_list(checklist, "No attendee checklist items found in sources."),
    ]

    hackathon = event.get("hackathon") if isinstance(event.get("hackathon"), dict) else {}
    if hackathon:
        sections.extend(
            [
                "## Hackathon Details",
                bullet_list(
                    [
                        f"Team rules: {text(hackathon.get('team_rules'))}",
                        f"Judging: {text(hackathon.get('judging'))}",
                        f"Deliverables: {text(hackathon.get('deliverables'))}",
                        f"Prizes: {text(hackathon.get('prizes'))}",
                    ],
                    "No hackathon details found in sources.",
                ),
            ]
        )

    workshop = event.get("workshop") if isinstance(event.get("workshop"), dict) else {}
    if workshop:
        setup = [f"Setup: {text(item)}" for item in as_list(workshop.get("setup"))]
        materials = [f"Material: {text(item)}" for item in as_list(workshop.get("materials"))]
        sections.extend(
            [
                "## Workshop Details",
                bullet_list(setup + materials, "No workshop details found in sources."),
            ]
        )

    sections.extend(
        [
            "## Sponsors",
            bullet_list(as_list(event.get("sponsors")), "No sponsors found in sources."),
            "## Unresolved Questions",
            bullet_list(as_list(data.get("unresolved_questions")), "No unresolved questions recorded."),
            "## Source Notes",
            "\n".join(source_notes) if source_notes else "No sources recorded.",
        ]
    )
    return "\n\n".join(sections)


def render_speaker_markdown(speaker: dict[str, Any]) -> str:
    name = text(speaker.get("name"), "Unknown Speaker")
    profile_rows = [
        ("Headline", speaker.get("headline")),
        ("Role", speaker.get("role")),
        ("Affiliation", speaker.get("affiliation")),
        ("Current roles", ", ".join(text(item) for item in as_list(speaker.get("current_roles")))),
    ]
    profile_table = ["| Field | Value |", "| --- | --- |"]
    profile_table.extend(table_row([label, value]) for label, value in profile_rows if text(value, "") != "")

    links = []
    for link in as_list(speaker.get("links")):
        item = normalize_link(link)
        label = md_link(item.get("label") or item.get("url"), item.get("url"))
        kind = text(item.get("kind"), "")
        links.append(f"- {label}" + (f" - {kind}" if kind else ""))

    sources = []
    for source in as_list(speaker.get("sources")):
        item = normalize_source(source)
        sources.append(md_link(item.get("title") or item.get("url"), item.get("url")))

    return "\n\n".join(
        [
            f"# {name}",
            "## Profile",
            text(speaker.get("bio"), "No biography found in sources."),
            "",
            "\n".join(profile_table) if len(profile_table) > 2 else "No profile facts found in sources.",
            "## Background",
            "### Education",
            rich_bullet_list(as_list(speaker.get("education"))),
            "### Career",
            rich_bullet_list(as_list(speaker.get("career"))),
            "### Communities",
            rich_bullet_list(as_list(speaker.get("communities"))),
            "### Awards",
            rich_bullet_list(as_list(speaker.get("awards"))),
            "## Technical Focus",
            "### Focus Areas",
            rich_bullet_list(as_list(speaker.get("technical_focus"))),
            "### Technical Stack",
            rich_bullet_list(as_list(speaker.get("technical_stack"))),
            "## Notable Work",
            "### Projects and Products",
            rich_bullet_list(as_list(speaker.get("notable_work"))),
            "### Publications and Talks",
            rich_bullet_list(as_list(speaker.get("publications_talks"))),
            "## Event Relevance",
            text(speaker.get("event_relevance"), "Not found in sources."),
            "",
            "### Research Notes",
            rich_bullet_list(as_list(speaker.get("research_notes")), "No research notes recorded."),
            "## Sessions",
            bullet_list(as_list(speaker.get("sessions")), "No sessions mapped."),
            "## Links",
            "\n".join(links) if links else "No speaker links found.",
            "## Sources",
            bullet_list(sources, "No speaker sources recorded."),
        ]
    )


def render_links_markdown(data: dict[str, Any]) -> str:
    grouped: dict[str, list[str]] = {kind: [] for kind in LINK_KINDS}
    for link in as_list(data.get("links")):
        item = normalize_link(link)
        kind = text(item.get("kind"), "other").lower()
        if kind not in grouped:
            kind = "other"
        label = md_link(item.get("label") or item.get("url"), item.get("url"))
        note = text(item.get("note"), "")
        grouped[kind].append(f"- {label}" + (f" - {note}" if note else ""))

    sections = ["# Links"]
    for kind in LINK_KINDS:
        title = kind.replace("_", " ").title()
        sections.extend([f"## {title}", "\n".join(grouped[kind]) if grouped[kind] else "None recorded."])
    return "\n\n".join(sections)


def render_sources_markdown(data: dict[str, Any]) -> str:
    sources = [normalize_source(source) for source in as_list(data.get("sources"))]
    lines = [
        "# Sources",
        "",
        "| Source | Retrieved | Kind | Confidence | Notes |",
        "| --- | --- | --- | --- | --- |",
    ]
    if not sources:
        lines.append(table_row(["No sources recorded", "", "", "", ""]))
    for source in sources:
        lines.append(
            table_row(
                [
                    md_link(source.get("title") or source.get("url"), source.get("url")),
                    source.get("retrieved_at"),
                    source.get("kind"),
                    source.get("confidence"),
                    source.get("notes"),
                ]
            )
        )
    return "\n".join(lines)


def render(data: dict[str, Any], output_dir: Path) -> list[Path]:
    speakers = [item for item in as_list(data.get("speakers")) if isinstance(item, dict)]
    speaker_slugs: dict[str, str] = {}
    used_slugs: set[str] = set()
    for speaker in speakers:
        name = text(speaker.get("name"), "Unknown Speaker")
        base = slugify(speaker.get("slug") or name, "speaker")
        speaker_slugs[name] = unique_slug(base, used_slugs)

    written: list[Path] = []
    event_path = output_dir / "event.md"
    links_path = output_dir / "links.md"
    sources_path = output_dir / "sources.md"
    write_file(event_path, render_event_markdown(data, speaker_slugs))
    write_file(links_path, render_links_markdown(data))
    write_file(sources_path, render_sources_markdown(data))
    written.extend([event_path, links_path, sources_path])

    for speaker in speakers:
        name = text(speaker.get("name"), "Unknown Speaker")
        slug = speaker_slugs[name]
        path = output_dir / "speakers" / f"{slug}.md"
        write_file(path, render_speaker_markdown(speaker))
        written.append(path)

    return written


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit("Top-level JSON value must be an object.")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render event research JSON into event.md, links.md, sources.md, and speaker files.",
    )
    parser.add_argument("json_file", type=Path, help="Path to event research JSON")
    parser.add_argument("output_dir", type=Path, help="Directory where Markdown files should be written")
    args = parser.parse_args()

    data = load_json(args.json_file)
    written = render(data, args.output_dir)
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
