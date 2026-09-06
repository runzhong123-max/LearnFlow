"""
Source processing and text chunking service with directory analysis + chunk tagging.
"""
import os
import re
import json
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import List, Optional, Dict

from langchain_text_splitters import RecursiveCharacterTextSplitter
from bs4 import BeautifulSoup

from app.services.file_formats import (
    DEFAULT_EXTRACTION_BUDGET,
    FORMAT_REGISTRY_VERSION,
    UNTRUSTED_SOURCE_BOUNDARY,
    FileFormatError,
    extract_bytes,
    extract_path,
    format_id_for_filename,
    is_source_filename,
    source_extensions,
)
from app.services.source_locator import SOURCE_LOCATOR, SourceLocationError, SourceLocator


_GIT_CLONE_FALLBACK_CODES = {
    "git_unavailable",
    "git_clone_failed",
    "git_clone_timeout",
    "git_clone_budget_exceeded",
}


class SourceProcessor:
    """Process sources and produce tagged chunks + directory metadata."""

    def __init__(
        self,
        chunk_size: int = 2000,
        chunk_overlap: int = 200,
        *,
        source_locator: SourceLocator | None = None,
    ):
        self.splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separators=["\n## ", "\n### ", "\n#### ", "\n", ". ", " ", ""],
        )
        self.source_locator = source_locator or SOURCE_LOCATOR

    # ── URL Handling ──

    async def fetch_url(self, url: str) -> str:
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 LearnFlow/1.0"}
        response = await self.source_locator.fetch(
            url,
            headers=headers,
            max_response_bytes=5 * 1024 * 1024,
        )
        html = response.text(max_characters=DEFAULT_EXTRACTION_BUDGET.max_characters * 2)
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()
        article = soup.find("article")
        text = article.get_text(separator="\n", strip=True) if article else soup.get_text(separator="\n", strip=True)
        return re.sub(r"\n{3,}", "\n\n", text)

    # ── GitHub Handling ──

    def _parse_gh_url(self, url: str) -> tuple:
        return self.source_locator.github_coordinates(url)

    async def fetch_github_readme(self, repo_url: str) -> str:
        owner, repo = self._parse_gh_url(repo_url)
        urls = [
            f"https://raw.githubusercontent.com/{owner}/{repo}/main/README.md",
            f"https://raw.githubusercontent.com/{owner}/{repo}/main/README.rst",
            f"https://raw.githubusercontent.com/{owner}/{repo}/master/README.md",
            f"https://raw.githubusercontent.com/{owner}/{repo}/master/README.rst",
            f"https://api.github.com/repos/{owner}/{repo}/readme",
        ]
        headers = {"User-Agent": "LearnFlow/1.0", "Accept": "application/vnd.github.v3.raw"}
        for candidate in urls:
            try:
                response = await self.source_locator.fetch(
                    candidate,
                    headers=headers,
                    max_response_bytes=5 * 1024 * 1024,
                    raise_for_status=False,
                )
                if response.status_code == 200:
                    return response.text(max_characters=DEFAULT_EXTRACTION_BUDGET.max_characters)
            except SourceLocationError:
                raise
            except Exception:
                continue
        raise ValueError(f"Could not fetch README for {repo_url}")

    # ── Clone + Extract + Analyze ──

    def _skip_dir(self, name: str) -> bool:
        skip = {".git", ".github", "node_modules", "__pycache__", "build", "dist",
                "venv", ".venv", "env", ".ipynb_checkpoints", "site-packages",
                "bower_components", "target", "vendor", ".gradle", "coverage",
                # multi-language translation copies (huge duplication, e.g.
                # microsoft/ML-For-Beginners has 20+ language copies)
                "translations", "translated_images", "i18n", "locales", "locale"}
        return name in skip or (name.startswith(".") and name not in {".", ".ci", ".devcontainer"})

    # Compatibility alias for callers/tests; the registry is the authority.
    _READABLE_EXTS = set(source_extensions())

    _IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"}

    def _should_persist(self, fname: str) -> bool:
        """Files kept in the repo cache (needed for rendering/captioning)."""
        ext = f".{fname.split('.')[-1].lower()}" if "." in fname else ""
        return ext in self._IMAGE_EXTS or fname.lower() in {"readme.md", "readme.rst"} or ext in {".md", ".markdown", ".rst"}

    @staticmethod
    def _extraction_meta(
        *,
        files: list[dict],
        warnings: list[str],
        input_bytes: int,
        truncated: bool,
        ignored_unsupported: int = 0,
    ) -> dict:
        """Return bounded provenance without turning source content into evidence."""
        visible_warnings = warnings[:100]
        if len(warnings) > len(visible_warnings):
            visible_warnings.append(f"另有 {len(warnings) - len(visible_warnings)} 条解析告警未展开")
        return {
            "format_registry_version": FORMAT_REGISTRY_VERSION,
            "format_ids": sorted({str(item.get("format_id")) for item in files if item.get("format_id")}),
            "extracted_files": files[:100],
            "extracted_file_count": len(files),
            "ignored_unsupported_file_count": ignored_unsupported,
            "input_bytes": input_bytes,
            "truncated": truncated,
            "warnings": visible_warnings,
            "trust_boundary": UNTRUSTED_SOURCE_BOUNDARY,
            "mastery_inference": False,
            "execution_performed": False,
        }

    @staticmethod
    def _append_extracted_block(
        text_parts: list[str],
        logical_name: str,
        content: str,
        current_characters: int,
    ) -> tuple[int, bool]:
        safe_name = re.sub(r"[\x00\r\n]", "�", str(logical_name))[:1000]
        safe_content = re.sub(
            r"(?m)^(=== .+? ===)$",
            r"\\\1",
            content.strip(),
        )
        block = f"=== {safe_name} ===\n{safe_content}\n"
        remaining = DEFAULT_EXTRACTION_BUDGET.max_characters - current_characters
        if remaining <= 0:
            return current_characters, True
        clipped = len(block) > remaining
        if clipped:
            block = block[:remaining]
        if block.strip():
            text_parts.append(block)
            current_characters += len(block)
        return current_characters, clipped

    async def clone_and_extract(self, repo_url: str, persist_dir: str = None) -> dict:
        """
        Clone repo and return:
          text: combined content for chunking
          dir_tree: directory structure {path: {"type":"file"|"dir", "size":int}}
          readme_content: raw README text
        """
        clean_url = self.source_locator.normalize_github_url(repo_url)
        dir_tree = {}

        with tempfile.TemporaryDirectory() as tmpdir:
            await self.source_locator.clone_github(clean_url, tmpdir)

            text_parts: list[str] = []
            readme_text = ""
            extraction_warnings: list[str] = []
            extracted_files: list[dict] = []
            examined_files = 0
            ignored_unsupported = 0
            input_bytes = 0
            output_characters = 0
            extraction_truncated = False
            file_limit_reported = False
            output_limit_reported = False
            repository_entries = 0
            entry_limit_reported = False

            for root, dirs, files in os.walk(tmpdir):
                # Filter dirs
                safe_dirs = [
                    directory for directory in dirs
                    if not self._skip_dir(directory)
                    and not (Path(root) / directory).is_symlink()
                ]
                remaining_entries = DEFAULT_EXTRACTION_BUDGET.max_container_entries - repository_entries
                if remaining_entries <= 0:
                    dirs[:] = []
                    extraction_truncated = True
                    if not entry_limit_reported:
                        extraction_warnings.append("repository_entry_budget_exceeded: 仓库目录条目超过预算")
                        entry_limit_reported = True
                    break
                dirs[:] = safe_dirs[:remaining_entries]
                rel_dir = os.path.relpath(root, tmpdir)
                if rel_dir == ".":
                    rel_dir = ""
                for d in dirs:
                    repository_entries += 1
                    dir_path = f"{rel_dir}/{d}" if rel_dir else d
                    dir_tree[dir_path] = {"type": "dir"}

                for fname in files:
                    if repository_entries >= DEFAULT_EXTRACTION_BUDGET.max_container_entries:
                        extraction_truncated = True
                        if not entry_limit_reported:
                            extraction_warnings.append("repository_entry_budget_exceeded: 仓库目录条目超过预算")
                            entry_limit_reported = True
                        dirs[:] = []
                        break
                    repository_entries += 1
                    rel_path = f"{rel_dir}/{fname}" if rel_dir else fname
                    fpath = os.path.join(root, fname)
                    if Path(fpath).is_symlink():
                        extraction_warnings.append(f"{rel_path}: symlink_ignored: 仓库符号链接不会被解引用")
                        continue
                    try:
                        fsize = os.path.getsize(fpath)
                    except OSError:
                        extraction_warnings.append(f"{rel_path}: file_unreadable: 无法读取文件大小")
                        continue

                    dir_tree[rel_path] = {"type": "file", "size": fsize}

                    if not is_source_filename(fname):
                        ignored_unsupported += 1
                        continue
                    if examined_files >= DEFAULT_EXTRACTION_BUDGET.max_files:
                        extraction_truncated = True
                        if not file_limit_reported:
                            extraction_warnings.append(
                                "repository_file_budget_exceeded: 可解析文件数量超过预算"
                            )
                            file_limit_reported = True
                        continue
                    if output_characters >= DEFAULT_EXTRACTION_BUDGET.max_characters:
                        extraction_truncated = True
                        if not output_limit_reported:
                            extraction_warnings.append(
                                "repository_character_budget_exceeded: 累计抽取字符超过预算"
                            )
                            output_limit_reported = True
                        continue
                    examined_files += 1
                    if input_bytes + fsize > DEFAULT_EXTRACTION_BUDGET.max_total_input_bytes:
                        extraction_truncated = True
                        extraction_warnings.append(
                            f"{rel_path}: total_input_budget_exceeded: 仓库累计输入大小超过预算"
                        )
                        continue
                    input_bytes += fsize

                    try:
                        extracted = extract_path(fpath, filename=fname)
                    except FileFormatError as exc:
                        extraction_warnings.append(f"{rel_path}: {exc.code}: {exc}")
                        continue
                    content = extracted.text
                    if fname.casefold() in {"readme.md", "readme.rst", "readme.markdown"}:
                        readme_text = content
                    output_characters, clipped = self._append_extracted_block(
                        text_parts, rel_path, content, output_characters,
                    )
                    extraction_truncated = extraction_truncated or extracted.truncated or clipped
                    extraction_warnings.extend(
                        f"{rel_path}: extraction_warning: {warning}"
                        for warning in extracted.warnings
                    )
                    extracted_files.append({
                        "path": rel_path,
                        "format_id": extracted.detected.format_id,
                        "encoding": extracted.detected.encoding,
                        "truncated": extracted.truncated or clipped,
                        "counters": extracted.counters,
                    })

            # Persist images + markdown into the repo cache (T6)
            if persist_dir:
                os.makedirs(persist_dir, exist_ok=True)
                persisted_scan_entries = 0
                for root, dirs, files in os.walk(tmpdir):
                    safe_dirs = [
                        directory for directory in dirs
                        if not self._skip_dir(directory)
                        and not (Path(root) / directory).is_symlink()
                    ]
                    remaining_entries = (
                        DEFAULT_EXTRACTION_BUDGET.max_container_entries - persisted_scan_entries
                    )
                    if remaining_entries <= 0:
                        dirs[:] = []
                        break
                    dirs[:] = safe_dirs[:remaining_entries]
                    persisted_scan_entries += len(dirs)
                    rel_dir = os.path.relpath(root, tmpdir)
                    if rel_dir == ".":
                        rel_dir = ""
                    for fname in files:
                        if persisted_scan_entries >= DEFAULT_EXTRACTION_BUDGET.max_container_entries:
                            dirs[:] = []
                            break
                        persisted_scan_entries += 1
                        if not self._should_persist(fname):
                            continue
                        rel_path = f"{rel_dir}/{fname}" if rel_dir else fname
                        src = os.path.join(root, fname)
                        if Path(src).is_symlink():
                            continue
                        try:
                            if os.path.getsize(src) > 5 * 1024 * 1024:
                                continue
                        except OSError:
                            continue
                        dst = os.path.join(persist_dir, rel_path)
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        try:
                            shutil.copy2(src, dst)
                        except OSError:
                            pass

            if not text_parts:
                reason = extraction_warnings[0] if extraction_warnings else "没有注册表支持的来源文件"
                raise ValueError(f"No readable content found in {repo_url}: {reason}")

            return {
                "text": "".join(text_parts),
                "dir_tree": dir_tree,
                "readme": readme_text,
                "extraction_meta": self._extraction_meta(
                    files=extracted_files,
                    warnings=extraction_warnings,
                    input_bytes=input_bytes,
                    truncated=extraction_truncated,
                    ignored_unsupported=ignored_unsupported,
                ),
            }

    # ── Chunk with Tags ──

    def _extract_headings(self, text: str, file_path: str = "") -> List[str]:
        """Extract markdown headings from content."""
        headings = re.findall(r"^(#{1,4})\s+(.+)$", text, re.MULTILINE)
        return [h[1].strip() for h in headings[:10]]

    def _extract_topic_hints(self, text: str) -> List[str]:
        """Extract topic keywords from chunk content."""
        # Look for bold terms, code keywords, and first sentence
        hints = []
        bold = re.findall(r"\*\*(.+?)\*\*", text)
        hints.extend(b[:30] for b in bold[:5])
        # First meaningful sentence
        sentences = re.split(r'[.。!！?？\n]', text.strip())
        if sentences and len(sentences[0]) > 5:
            hints.append(sentences[0][:60])
        return hints

    def _parse_file_path_from_content(self, content: str) -> str:
        """Extract === path === from anywhere in chunk content."""
        # Try start of chunk first (most reliable)
        m = re.match(r"^=== (.+?) ===\n?", content)
        if m:
            return m.group(1)
        # Try end of previous content (=== path === comes before ## heading)
        m = re.search(r"=== (.+?) ===\n", content[:200])
        if m:
            return m.group(1)
        return ""

    def chunk_text(self, text: str, source_type: str = "url") -> List[dict]:
        """Split text into chunks with rich metadata tags (T4: structure-aware).

        Walks through combined text line-by-line, collecting file blocks
        at === path === markers, then chunks each file independently:
        - markdown files: split by heading hierarchy (##/###/####), merge
          small sections into ~1500-2500 char chunks; every chunk carries its
          full heading chain + position.
        - code/other files: line-based recursive split.
        Every chunk gets prev/next index within its file so downstream
        generators can preserve the source's flow.
        """
        result = []
        chunk_index = 0

        lines = text.split("\n")
        current_file = ""
        current_content = []

        def flush_current():
            """Process buffered content as chunks for the current file."""
            nonlocal chunk_index
            if not current_content:
                return
            content = "\n".join(current_content).strip()
            if not content:
                return
            for fc in self._chunk_file(content, current_file, source_type):
                fc["meta"]["chunk_index"] = chunk_index
                result.append(fc)
                chunk_index += 1

        for line in lines:
            # Check for file path marker
            m = re.match(r"^=== (.+?) ===$", line.strip())
            if m:
                flush_current()
                current_file = m.group(1)
                current_content = []
            else:
                current_content.append(line)

        flush_current()
        self._assign_prev_next(result)
        return result

    # ── Per-file chunking (T4) ──

    _CODE_EXTS = {
        ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs",
        ".c", ".h", ".cc", ".cpp", ".cs", ".rb", ".php", ".swift", ".kt",
    }

    def _document_kind(self, content: str, file_path: str, source_type: str) -> str:
        suffix = Path(file_path).suffix.casefold()
        lowered = content[:8000].casefold()
        if suffix in self._CODE_EXTS:
            return "code"
        if suffix in {".srt", ".vtt"} or source_type in {"video", "subtitle"}:
            return "video_transcript"
        if suffix in {".yaml", ".yml", ".json"} and re.search(r"\b(openapi|swagger)\b", lowered):
            return "api_reference"
        if suffix == ".pdf" or (
            re.search(r"(?m)^#{1,3}\s+(abstract|摘要)\b", content, re.I)
            and re.search(r"(?m)^#{1,3}\s+(references|参考文献)\b", content, re.I)
        ):
            return "paper"
        if source_type in {"community", "discussion", "forum"}:
            return "community_thread"
        return "structured_document"

    @staticmethod
    def _retrieval_lanes(document_kind: str) -> list[str]:
        return {
            "code": ["lexical", "symbol", "path", "semantic_optional"],
            "api_reference": ["lexical", "schema_path", "semantic_optional"],
            "paper": ["lexical", "section", "citation", "semantic_optional"],
            "video_transcript": ["lexical", "timestamp", "semantic_optional"],
            "community_thread": ["lexical", "thread_role", "recency", "semantic_optional"],
        }.get(document_kind, ["lexical", "heading", "semantic_optional"])

    @staticmethod
    def _extract_symbols(text: str) -> list[str]:
        symbols = re.findall(
            r"(?m)^\s*(?:async\s+)?(?:def|class|function|interface|type|enum|func)\s+([A-Za-z_$][\w$]*)",
            text,
        )
        return list(dict.fromkeys(symbols))[:30]

    def _base_chunk_meta(self, content: str, file_path: str, source_type: str) -> dict:
        kind = self._document_kind(content, file_path, source_type)
        strategy = {
            "code": "code_symbol",
            "api_reference": "schema_section",
            "paper": "paper_section",
            "video_transcript": "video_timestamp",
            "community_thread": "community_thread",
        }.get(kind, "heading_parent_child")
        return {
            "source_type": source_type,
            "file": file_path,
            "format_registry_version": FORMAT_REGISTRY_VERSION,
            "format_id": format_id_for_filename(file_path),
            "source_trust": "untrusted",
            "mastery_inference": False,
            "execution_performed": False,
            "document_kind": kind,
            "chunking_strategy": strategy,
            "retrieval_lanes": self._retrieval_lanes(kind),
        }

    def _chunk_file(self, content: str, file_path: str, source_type: str) -> List[dict]:
        """Chunk a single file: markdown → heading-based; other → line split."""
        if self._document_kind(content, file_path, source_type) == "code":
            return self._chunk_code(content, file_path, source_type)
        # Markdown detection: any # heading?
        if re.search(r"^#{1,6}\s+", content, re.MULTILINE):
            return self._chunk_markdown(content, file_path, source_type)
        return self._chunk_plain(content, file_path, source_type)

    def _chunk_markdown(self, content: str, file_path: str, source_type: str) -> List[dict]:
        """Heading-hierarchy chunking with full heading chain per chunk."""
        sections = []  # (level, title, lines)
        stack = []     # (level, title) open headings
        preamble = []

        for line in content.split("\n"):
            m = re.match(r"^(#{1,6})\s+(.+)$", line)
            if m:
                level = len(m.group(1))
                title = m.group(2).strip()
                # Close headings deeper/equal than this one
                while stack and stack[-1][0] >= level:
                    stack.pop()
                stack.append((level, title))
                sections.append({"level": level, "title": title,
                                 "chain": [t for _, t in stack], "lines": [line]})
            else:
                if not sections:
                    preamble.append(line)
                else:
                    sections[-1]["lines"].append(line)

        if not sections:
            return self._chunk_plain(content, file_path, source_type)

        # Preamble becomes the first section if substantial
        if preamble and len("\n".join(preamble).strip()) > 40:
            sections.insert(0, {"level": 0, "title": "",
                                "chain": [], "lines": preamble})

        # Group small sections into chunks of ~1500-2500 chars
        MIN_SIZE, MAX_SIZE = 1200, 3200
        groups = []
        cur = {"chain": [], "lines": [], "size": 0}
        for sec in sections:
            sec_size = sum(len(l) + 1 for l in sec["lines"])
            if cur["lines"] and cur["size"] + sec_size > MAX_SIZE:
                groups.append(cur)
                cur = {"chain": [], "lines": [], "size": 0}
            # chain = the first section's chain (ancestor headings)
            if not cur["lines"]:
                cur["chain"] = list(sec["chain"])
            cur["lines"].extend(sec["lines"])
            cur["size"] += sec_size
        if cur["lines"]:
            groups.append(cur)

        # Oversized single sections: split by paragraph
        chunks = []
        for g in groups:
            if g["size"] > MAX_SIZE * 1.6 and len(g["lines"]) > 20:
                para = []
                for line in g["lines"]:
                    para.append(line)
                    if line.strip() == "" and sum(len(l) for l in para) > MAX_SIZE:
                        chunks.append((list(g["chain"]), para))
                        para = []
                if para:
                    chunks.append((list(g["chain"]), para))
            else:
                chunks.append((list(g["chain"]), g["lines"]))

        result = []
        for chain, lines in chunks:
            text = "\n".join(lines).strip()
            if not text:
                continue
            # headings = titles inside this chunk
            headings = []
            for ln in lines:
                m = re.match(r"^#{1,6}\s+(.+)$", ln)
                if m:
                    headings.append(m.group(1).strip())
            result.append({
                "index": 0,  # global index assigned by caller
                "content": text,
                "tokens": len(text) // 4,
                "meta": {
                    **self._base_chunk_meta(text, file_path, source_type),
                    "headings": headings[:20],
                    "heading_chain": chain[:20],
                    "topic_hints": self._extract_topic_hints(text),
                    "chunk_index": 0,
                },
            })
        return result

    def _chunk_code(self, content: str, file_path: str, source_type: str) -> List[dict]:
        """Keep code symbols and line locators available to hybrid retrieval."""
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=2400,
            chunk_overlap=160,
            separators=["\nclass ", "\nasync def ", "\ndef ", "\nfunction ", "\ninterface ", "\n", " "],
        )
        cursor = 0
        result = []
        for text in splitter.split_text(content):
            if not text.strip():
                continue
            start = content.find(text, cursor)
            if start < 0:
                start = content.find(text)
            start = max(0, start)
            cursor = start + len(text)
            line_start = content.count("\n", 0, start) + 1
            line_end = line_start + text.count("\n")
            result.append({
                "index": 0,
                "content": text.strip(),
                "tokens": max(1, len(text) // 4),
                "meta": {
                    **self._base_chunk_meta(text, file_path, source_type),
                    "headings": [],
                    "heading_chain": [],
                    "symbols": self._extract_symbols(text),
                    "line_start": line_start,
                    "line_end": line_end,
                    "topic_hints": self._extract_topic_hints(text),
                    "chunk_index": 0,
                },
            })
        return result

    def _chunk_plain(self, content: str, file_path: str, source_type: str) -> List[dict]:
        """Fallback for non-markdown files: recursive line split."""
        file_chunks = self.splitter.split_text(content)
        result = []
        for fc in file_chunks:
            if not fc.strip():
                continue
            result.append({
                "index": 0,
                "content": fc.strip(),
                "tokens": len(fc) // 4,
                "meta": {
                    **self._base_chunk_meta(fc, file_path, source_type),
                    "headings": [],
                    "heading_chain": [],
                    "topic_hints": self._extract_topic_hints(fc),
                    "chunk_index": 0,
                },
            })
        return result

    def _assign_prev_next(self, chunks: List[dict]) -> None:
        """Set prev_index/next_index (global chunk indexes) within each file."""
        by_file = {}
        for c in chunks:
            fp = c["meta"].get("file", "")
            by_file.setdefault(fp, []).append(c)
        for file_chunks in by_file.values():
            for i, c in enumerate(file_chunks):
                idx = c["meta"]["chunk_index"]
                c["meta"]["prev_index"] = file_chunks[i - 1]["meta"]["chunk_index"] if i > 0 else None
                c["meta"]["next_index"] = file_chunks[i + 1]["meta"]["chunk_index"] if i < len(file_chunks) - 1 else None

    # ── README TOC Parser (Level 1) ──

    def parse_readme_toc(self, readme_text: str) -> list:
        """Extract table of contents from README."""
        toc = []
        if not readme_text:
            return toc

        lines = readme_text.split("\n")

        # Strategy 1: Look for bullet-list ToC (common in GitHub README)
        # "[text](#link)" pattern
        in_toc_section = False
        toc_markers = ["table of contents", "目录", "overview"]

        for line in lines:
            lower = line.strip().lower()
            # Detect TOC section
            if any(m in lower for m in toc_markers) and line.strip().startswith("#"):
                in_toc_section = True
                continue
            if in_toc_section:
                # End of TOC: next heading or blank line after bullets
                if line.strip().startswith("#"):
                    break
                # Parse bullet links: - [Title](#section) or - [Title](url)
                m = re.match(r"^\s*[-*+]\s+\[(.+?)\]\(#?(.+?)\)", line)
                if m:
                    toc.append({"title": m.group(1).strip(), "link": m.group(2).strip()})
                    continue
                # Plain bullet without link
                m = re.match(r"^\s*[-*+]\s+(.+)", line)
                if m:
                    text = m.group(1).strip()
                    if text and not text.startswith("["):
                        toc.append({"title": text, "link": ""})
                    continue

            # Strategy 2: Numbered list with links
            m = re.match(r"^\s*\d+[.、]\s+\[(.+?)\]\((.+?)\)", line)
            if m:
                toc.append({"title": m.group(1).strip(), "link": m.group(2).strip()})

        # Strategy 3: Section headings from README itself
        if not toc:
            for line in lines:
                m = re.match(r"^##\s+(.+)", line)
                if m:
                    title = m.group(1).strip()
                    if title.lower() not in ("table of contents", "overview", "目录"):
                        toc.append({"title": title, "link": ""})

        return toc

    # ── Directory Heuristic (Level 2) ──

    def analyze_directory_structure(self, dir_tree: Dict) -> dict:
        """Analyze directory tree to identify content groups."""
        files = [(k, v) for k, v in dir_tree.items() if v.get("type") == "file"]

        # Find chapter/directory groups
        groups = {}
        for path, info in files:
            parts = path.split("/")
            if len(parts) >= 2:
                group_dir = parts[0]
                if group_dir not in groups:
                    groups[group_dir] = {"dir": group_dir, "files": [], "count": 0, "extensions": set()}
                groups[group_dir]["files"].append(path)
                groups[group_dir]["count"] += 1
                ext = f".{path.split('.')[-1]}"
                groups[group_dir]["extensions"].add(ext)

        # Build nice names for groups
        result = []
        for g in sorted(groups.values(), key=lambda x: x["dir"]):
            # Heuristically name: replace _ with space, remove common prefixes
            nice = g["dir"].replace("_", " ").replace("-", " ").title()
            # Check if looks like a chapter directory
            is_chapter = any(kw in g["dir"].lower() for kw in ["chapter", "lesson", "sec", "part", "module"])
            result.append({
                "name": nice,
                "dir": g["dir"],
                "files": g["files"],
                "count": g["count"],
                "is_chapter": is_chapter,
            })

        return {"groups": result, "total_files": len(files)}

    # ── Structure Confidence (L0) + Logic Type ──

    def _normalize_title(self, s: str) -> str:
        """Normalize a title for fuzzy comparison."""
        import unicodedata
        s = unicodedata.normalize("NFKC", s or "").lower().strip()
        s = re.sub(r"[\s\-_./\\:：·、,，()（）\[\]\d]+", "", s)
        return s

    def compute_structure_confidence(self, readme_toc: list, dir_groups: list) -> dict:
        """
        Multi-strategy agreement check (L0):
        - README TOC vs directory groups overlap → high/medium/low.
        - "high" means the roadmap agent can trust the structure; "low" means
          it should read actual files before planning.
        """
        reasons = []
        if not readme_toc:
            return {"level": "low", "reasons": ["README 没有可解析的目录"]}
        if not dir_groups:
            return {"level": "low", "reasons": ["仓库没有明显的分组目录"]}

        toc_norm = {self._normalize_title(t.get("title", "")) for t in readme_toc}
        group_norm = {self._normalize_title(g.get("name", "")) for g in dir_groups}
        group_norm |= {self._normalize_title(g.get("dir", "")) for g in dir_groups}

        if not toc_norm:
            return {"level": "low", "reasons": ["README 目录为空"]}

        overlap = len(toc_norm & group_norm)
        ratio = overlap / len(toc_norm)
        reasons.append(f"TOC {len(toc_norm)} 项与目录分组重叠 {overlap} 项（{ratio:.0%}）")

        if ratio >= 0.7:
            level = "high"
            reasons.append("TOC 与目录结构高度一致")
        elif ratio >= 0.4:
            level = "medium"
            reasons.append("TOC 与目录结构部分一致，规划时需抽样核对文件")
        else:
            level = "low"
            reasons.append("TOC 与目录结构不一致，规划前应读取实际文件")

        return {"level": level, "reasons": reasons}

    def detect_structure_logic(self, dir_groups: list, readme_toc: list = None) -> str:
        """
        Detect the repo's organizational logic:
        - tutorial-progression: chapter/lesson/module dirs
        - project-steps: src/code + step/part/task naming
        - paper-logic: paper/arxiv/section naming
        Returns one of: tutorial-progression | project-steps | paper-logic | mixed
        """
        dir_names = " ".join(g.get("dir", "").lower() for g in (dir_groups or []))
        toc_text = " ".join(t.get("title", "").lower() for t in (readme_toc or []))
        blob = dir_names + " " + toc_text

        score = {"tutorial-progression": 0, "project-steps": 0, "paper-logic": 0}
        for kw in ("chapter", "lesson", "sec", "part", "module", "unit", "课程", "章节"):
            if kw in blob:
                score["tutorial-progression"] += 1
        for kw in ("src", "code", "step", "task", "stage", "阶段", "步骤", "实现"):
            if kw in blob:
                score["project-steps"] += 1
        for kw in ("paper", "arxiv", "section", "abstract", "论文", "定理", "证明"):
            if kw in blob:
                score["paper-logic"] += 1

        best = max(score, key=score.get)
        if score[best] == 0:
            return "mixed"
        if score[best] - sorted(score.values(), reverse=True)[1] <= 0 and score[best] <= 2:
            return "mixed"
        return best

    # ── Full Pipeline ──

    async def process_source(
        self,
        source_type: str,
        url: str,
        persist_dir: str = None,
        *,
        managed_file_root: str | None = None,
    ) -> dict:
        """
        Full pipeline: fetch → extract → analyze → chunk.
        Returns {chunks: [...], source_meta: {...}}.
        """
        normalized_type = str(source_type or "").strip().casefold()
        source_type = normalized_type
        if normalized_type == "file":
            # Only callers that already proved this path belongs to the exact
            # server-managed upload root may opt into local file processing.
            clean_url = str(self.source_locator.resolve_managed_file(url, managed_file_root))
        elif normalized_type in {"github", "url"}:
            reference = self.source_locator.normalize_remote_source(normalized_type, url)
            source_type = reference.source_type
            clean_url = reference.location
        else:
            raise ValueError(f"unsupported_source_type: {source_type}")

        if source_type == "github":
            try:
                result = await self.clone_and_extract(clean_url, persist_dir=persist_dir)
                text = result["text"]
                dir_tree = result.get("dir_tree", {})
                readme = result.get("readme", "")

                # Level 1: README TOC
                readme_toc = self.parse_readme_toc(readme)

                # Level 2: Directory analysis
                dir_analysis = self.analyze_directory_structure(dir_tree)

                # L0: structure confidence + logic type
                confidence = self.compute_structure_confidence(readme_toc, dir_analysis["groups"])
                logic = self.detect_structure_logic(dir_analysis["groups"], readme_toc)

                source_meta = {
                    "dir_tree_keys": list(dir_tree.keys())[:500],
                    "readme_toc": readme_toc,
                    "dir_groups": dir_analysis["groups"],
                    "total_files": dir_analysis["total_files"],
                    "structure_confidence": confidence,
                    "structure_logic": logic,
                    **result.get("extraction_meta", {}),
                }

                chunks = self.chunk_text(text, source_type="github")
                return {"chunks": chunks, "source_meta": source_meta}

            except ValueError as clone_error:
                if (
                    isinstance(clone_error, SourceLocationError)
                    and clone_error.code not in _GIT_CLONE_FALLBACK_CODES
                ):
                    raise
                try:
                    fallback = await self._fetch_github_via_api(clean_url)
                    text = fallback["text"]
                    source_meta = {
                        **fallback.get("extraction_meta", {}),
                        "ingestion_fallback": "github_api_tarball",
                        "clone_error": f"{type(clone_error).__name__}: {str(clone_error)[:400]}",
                    }
                except SourceLocationError:
                    raise
                except Exception as api_error:
                    text = await self.fetch_github_readme(clean_url)
                    text = re.sub(r"(?m)^(=== .+? ===)$", r"\\\1", text)
                    clipped = len(text) > DEFAULT_EXTRACTION_BUDGET.max_characters
                    text = text[:DEFAULT_EXTRACTION_BUDGET.max_characters]
                    source_meta = self._extraction_meta(
                        files=[{
                            "path": "README",
                            "format_id": "markdown",
                            "encoding": "http-decoded",
                            "truncated": clipped,
                            "counters": {"characters": len(text)},
                        }],
                        warnings=[
                            f"git_clone_fallback: {type(clone_error).__name__}: {str(clone_error)[:300]}",
                            f"github_api_fallback: {type(api_error).__name__}: {str(api_error)[:300]}",
                        ],
                        input_bytes=len(text.encode("utf-8")),
                        truncated=clipped,
                    )
                    source_meta["ingestion_fallback"] = "github_readme"
                chunks = self.chunk_text(text, source_type="github")
                return {"chunks": chunks, "source_meta": source_meta}
        elif source_type == "file":
            # Uploaded reference file: read from the private source store.
            # This path is never a linked project workspace path.
            raw = Path(clean_url)

            text_parts: list[str] = []
            extraction_warnings: list[str] = []
            extracted_files: list[dict] = []
            ignored_unsupported = 0
            examined_files = 0
            input_bytes = 0
            output_characters = 0
            extraction_truncated = False
            file_limit_reported = False
            output_limit_reported = False
            skip_dirs = {"node_modules", "__pycache__", ".git", ".venv", "venv", "runtime", "dist", "build", "data"}
            paths: list[Path] = []
            is_directory = raw.is_dir()
            if is_directory:
                scanned_entries = 0
                for root, dirs, files in os.walk(raw):
                    safe_dirs = [
                        directory for directory in dirs
                        if directory not in skip_dirs
                        and not (Path(root) / directory).is_symlink()
                    ]
                    remaining_entries = (
                        DEFAULT_EXTRACTION_BUDGET.max_container_entries - scanned_entries
                    )
                    if remaining_entries <= 0:
                        dirs[:] = []
                        extraction_truncated = True
                        extraction_warnings.append(
                            "directory_entry_budget_exceeded: 受管来源目录条目超过预算"
                        )
                        break
                    dirs[:] = safe_dirs[:remaining_entries]
                    scanned_entries += len(dirs)
                    for fn in sorted(files):
                        if scanned_entries >= DEFAULT_EXTRACTION_BUDGET.max_container_entries:
                            extraction_truncated = True
                            extraction_warnings.append(
                                "directory_entry_budget_exceeded: 受管来源目录条目超过预算"
                            )
                            dirs[:] = []
                            break
                        scanned_entries += 1
                        if fn.startswith("."):
                            continue
                        paths.append(Path(root) / fn)
            else:
                paths = [raw]

            for p in sorted(paths):
                logical_name = p.relative_to(raw).as_posix() if is_directory else p.name
                if p.is_symlink():
                    extraction_warnings.append(f"{logical_name}: symlink_ignored: 受管来源符号链接不会被解引用")
                    continue
                if is_directory and not is_source_filename(p.name):
                    ignored_unsupported += 1
                    continue
                if examined_files >= DEFAULT_EXTRACTION_BUDGET.max_files:
                    extraction_truncated = True
                    if not file_limit_reported:
                        extraction_warnings.append("directory_file_budget_exceeded: 可解析文件数量超过预算")
                        file_limit_reported = True
                    continue
                if output_characters >= DEFAULT_EXTRACTION_BUDGET.max_characters:
                    extraction_truncated = True
                    if not output_limit_reported:
                        extraction_warnings.append("directory_character_budget_exceeded: 累计抽取字符超过预算")
                        output_limit_reported = True
                    continue
                examined_files += 1
                try:
                    file_size = p.stat().st_size
                except OSError as exc:
                    message = f"{logical_name}: file_unreadable: {type(exc).__name__}"
                    if not is_directory:
                        raise ValueError(message) from exc
                    extraction_warnings.append(message)
                    continue
                if input_bytes + file_size > DEFAULT_EXTRACTION_BUDGET.max_total_input_bytes:
                    extraction_truncated = True
                    extraction_warnings.append(
                        f"{logical_name}: total_input_budget_exceeded: 目录累计输入大小超过预算"
                    )
                    continue
                input_bytes += file_size
                try:
                    extracted = extract_path(p, filename=p.name)
                except FileFormatError as exc:
                    message = f"{logical_name}: {exc.code}: {exc}"
                    if not is_directory:
                        raise ValueError(message) from exc
                    extraction_warnings.append(message)
                    continue
                output_characters, clipped = self._append_extracted_block(
                    text_parts, logical_name, extracted.text, output_characters,
                )
                extraction_truncated = extraction_truncated or extracted.truncated or clipped
                extraction_warnings.extend(
                    f"{logical_name}: extraction_warning: {warning}"
                    for warning in extracted.warnings
                )
                extracted_files.append({
                    "path": logical_name,
                    "format_id": extracted.detected.format_id,
                    "encoding": extracted.detected.encoding,
                    "truncated": extracted.truncated or clipped,
                    "counters": extracted.counters,
                })

            if not text_parts:
                reason = extraction_warnings[0] if extraction_warnings else "没有注册表支持的来源文件"
                raise ValueError(f"No readable content in {raw}: {reason}")
            text = "".join(text_parts)
            chunks = self.chunk_text(text, source_type="file")
            return {"chunks": chunks, "source_meta": {
                "local_path": str(raw),
                **self._extraction_meta(
                    files=extracted_files,
                    warnings=extraction_warnings,
                    input_bytes=input_bytes,
                    truncated=extraction_truncated,
                    ignored_unsupported=ignored_unsupported,
                ),
            }}
        else:
            text = await self.fetch_url(clean_url)
            text = re.sub(r"(?m)^(=== .+? ===)$", r"\\\1", text)
            clipped = len(text) > DEFAULT_EXTRACTION_BUDGET.max_characters
            text = text[:DEFAULT_EXTRACTION_BUDGET.max_characters]
            chunks = self.chunk_text(text, source_type="url")
            return {"chunks": chunks, "source_meta": self._extraction_meta(
                files=[],
                warnings=[],
                input_bytes=len(text.encode("utf-8")),
                truncated=clipped,
            )}

    async def _fetch_github_via_api(self, repo_url: str) -> dict:
        """Fallback: download repo as tarball via GitHub API."""
        import tarfile, io

        owner, repo = self._parse_gh_url(repo_url)
        tarball_url = f"https://api.github.com/repos/{owner}/{repo}/tarball"
        headers = {"User-Agent": "LearnFlow/1.0", "Accept": "application/vnd.github.v3+json"}
        response = await self.source_locator.fetch(
            tarball_url,
            headers=headers,
            max_response_bytes=DEFAULT_EXTRACTION_BUDGET.max_total_input_bytes,
            total_timeout_seconds=60.0,
        )
        data = response.body

        if len(data) > DEFAULT_EXTRACTION_BUDGET.max_total_input_bytes:
            raise ValueError("github_tarball_budget_exceeded: GitHub 压缩传输包超过输入预算")

        text_parts: list[str] = []
        extraction_warnings: list[str] = []
        extracted_files: list[dict] = []
        ignored_unsupported = 0
        examined_files = 0
        input_bytes = 0
        output_characters = 0
        extraction_truncated = False
        file_limit_reported = False
        output_limit_reported = False
        skip_parts = {"node_modules", "__pycache__", ".git", ".github", "build", "dist", "venv", ".venv", "env"}
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                for member_number, member in enumerate(tar, start=1):
                    if member_number > DEFAULT_EXTRACTION_BUDGET.max_container_entries:
                        extraction_truncated = True
                        extraction_warnings.append("container_entry_budget_exceeded: GitHub 归档条目超过预算")
                        break
                    if not member.isfile():
                        continue
                    if "\x00" in member.name or "\n" in member.name or "\r" in member.name:
                        extraction_warnings.append("unsafe_archive_path: GitHub 归档包含不安全文件名")
                        continue
                    logical_path = PurePosixPath(member.name)
                    if logical_path.is_absolute() or ".." in logical_path.parts:
                        extraction_warnings.append(f"{member.name[:200]}: unsafe_archive_path")
                        continue
                    if any(part in skip_parts for part in logical_path.parts):
                        continue
                    if not is_source_filename(member.name):
                        ignored_unsupported += 1
                        continue
                    if examined_files >= DEFAULT_EXTRACTION_BUDGET.max_files:
                        extraction_truncated = True
                        if not file_limit_reported:
                            extraction_warnings.append("repository_file_budget_exceeded: 可解析文件数量超过预算")
                            file_limit_reported = True
                        continue
                    if output_characters >= DEFAULT_EXTRACTION_BUDGET.max_characters:
                        extraction_truncated = True
                        if not output_limit_reported:
                            extraction_warnings.append(
                                "repository_character_budget_exceeded: 累计抽取字符超过预算"
                            )
                            output_limit_reported = True
                        continue
                    examined_files += 1
                    if member.size > DEFAULT_EXTRACTION_BUDGET.max_file_bytes:
                        extraction_warnings.append(
                            f"{member.name}: file_budget_exceeded: 单文件超过解析预算"
                        )
                        extraction_truncated = True
                        continue
                    if input_bytes + member.size > DEFAULT_EXTRACTION_BUDGET.max_total_input_bytes:
                        extraction_warnings.append(
                            f"{member.name}: total_input_budget_exceeded: 仓库累计输入大小超过预算"
                        )
                        extraction_truncated = True
                        continue
                    input_bytes += member.size
                    handle = tar.extractfile(member)
                    if handle is None:
                        extraction_warnings.append(f"{member.name}: file_unreadable: 无法读取归档成员")
                        continue
                    member_data = handle.read(DEFAULT_EXTRACTION_BUDGET.max_file_bytes + 1)
                    if len(member_data) != member.size:
                        extraction_warnings.append(f"{member.name}: corrupt_archive_member: 成员大小不一致")
                        continue
                    try:
                        extracted = extract_bytes(member_data, member.name)
                    except FileFormatError as exc:
                        extraction_warnings.append(f"{member.name}: {exc.code}: {exc}")
                        continue
                    output_characters, clipped = self._append_extracted_block(
                        text_parts, member.name, extracted.text, output_characters,
                    )
                    extraction_truncated = extraction_truncated or extracted.truncated or clipped
                    extraction_warnings.extend(
                        f"{member.name}: extraction_warning: {warning}"
                        for warning in extracted.warnings
                    )
                    extracted_files.append({
                        "path": member.name,
                        "format_id": extracted.detected.format_id,
                        "encoding": extracted.detected.encoding,
                        "truncated": extracted.truncated or clipped,
                        "counters": extracted.counters,
                    })
        except (tarfile.TarError, OSError) as exc:
            raise ValueError(f"corrupt_github_tarball: {type(exc).__name__}") from exc

        if not text_parts:
            reason = extraction_warnings[0] if extraction_warnings else "没有注册表支持的来源文件"
            raise ValueError(f"No readable content via API for {repo_url}: {reason}")
        return {
            "text": "".join(text_parts),
            "extraction_meta": self._extraction_meta(
                files=extracted_files,
                warnings=extraction_warnings,
                input_bytes=input_bytes,
                truncated=extraction_truncated,
                ignored_unsupported=ignored_unsupported,
            ),
        }
