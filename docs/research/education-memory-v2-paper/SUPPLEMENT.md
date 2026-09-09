# Evidence and Reproduction Supplement

This bundle reports existing LearnFlow measurements. It does not create new experimental observations. The English manuscript is an author-review draft, not a submission-format claim or a record of acceptance. Dataset and method limits in the manuscript apply to every derived figure.

## Artifacts

| Artifact | Purpose |
| --- | --- |
| `manuscript.md` | Editable English manuscript source |
| `LearnFlow_Educational_Memory_Manuscript.docx` | Editable Word review manuscript |
| `投稿说明与中文摘要.md` | Chinese explanation, candidate venue and outstanding evidence |
| `build_paper.py` | Re-derive figures and assert tables against retained measurements; build DOCX |
| `derived_results.json` | Source-derived aggregates and SHA-256 of all numerical inputs |
| `figures/*.svg` and `figures/*.png` | Vector originals and Word insertion images |
| `references.bib` | Bibliographic companion to the numbered reference list |

## Source identity

Product snapshot: `0da6615eeb2a5dded4101535e8534cd5494b43a9`. Deployment documentation snapshot: `d9cef3b`. Core: `0.2.5`; Web registry: `2026-09-08.9`; Desktop registry: `2026-09-08.9-desktop`. Writing this paper changes no application contract, state model, evaluation label, or production deployment.

The source commit in the formal suite is the runtime checkout baseline `66457a3e1235e30138403ccda7780c15941c05c4`, not a claim that the unmodified baseline was evaluated. The measured implementation is identified by 186 source hashes and `final-source-check.json`. The default-budget supplement checks 199 files because its driver/source inventory differs; these are not interchangeable sample counts.

Educational manifest SHA-256: `57f01d56473fcb683a1d2d9adaaaf04760fdd81a9db3c5e157fd5168f6f80873`.

LoCoMo repository commit: `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`; dataset SHA-256: `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`. Source provenance and licensing are documented in `evals/joint_memory/SOURCES.md`. The derived exports do not publish original conversational text, questions, or answers.

## Claim map

All paths below are relative to the repository root. Numerical input hashes are recorded automatically in `derived_results.json`.

| Manuscript claim or display | Primary evidence | Interpretation |
| --- | --- | --- |
| Table 1 and condition coverage | `evals/education_memory_v2/PROTOCOL.md`; `results/formal-03/suite.json`; `results/formal-03/final-source-check.json` under the same evaluation directory | Two complete condition matrices; repeated observations |
| Table 2 | `evals/education_memory_v2/PROTOCOL.md`; `components.py` | Intervention semantics, including retained components |
| Table 3 and Figure 3 left | `evals/education_memory_v2/results/formal-03/education-trials.jsonl.gz` | Sum `source_fact_evidence_delivered_formed_source_fact_numerator/denominator` per arm and budget; raw probe separately |
| Table 4 and Figure 3 right | `evals/education_memory_v2/results/formal-03/locomo-primary-audit.json` | `current_groups[].main`; valid categories 1/2/4 only |
| BM25 paired intervals | Same LoCoMo primary audit, `main_paired_comparisons` | Equal-conversation-weight bootstrap; not the question-weighted table mean |
| Figure 2 and 192 transitions | `results/formal-02-freshness-v2/summary.json`; `results/formal-03-freshness-v2/summary.json`; `paired-before-after.json` in the latter directory | Corrected post hoc audit on both runs |
| Default budget 2,900 | `evals/education_memory_v2/results/default-budget-2900/descriptive-summary.json` | 1,584 full-only education conditions; separate descriptive supplement |
| Teacher ratings absent | `evals/education_memory_v2/results/formal-03/teacher-review-preparation.json`; `teacher_review/RUBRIC.md` | Prepared plans and rubric, zero ratings |
| Deployment boundary | `docs/validation/2026-09-09-education-memory-v2-release.md` | Integration and isolated checks, no student outcome evidence |
| Authority and episode method | `packages/learning-core/src/learnflow_core/{five_kernel_context,memory_episode,planning_guidance,teaching_guidance,teaching_control_parser}.py` | Implemented code; no new authority in this paper |

The direct source-Fact probe is intentionally different from the broader attributed-evidence metric. The latter can count attributable text through other representations and yields different totals in some arms. Figures and manuscript Table 3 consistently use the direct source-Fact metric; the reproduction script rejects mixing them.

## Rebuild the paper displays

Use a Python runtime with `python-docx` and `reportlab`; SVG-to-PNG conversion uses Node with `sharp`. These are document dependencies, not product or experiment dependencies. The author's run used the Codex bundled runtime 26.905.11957, not repository-installed packages. Runtime paths depend on the host.

```bash
python docs/research/education-memory-v2-paper/build_paper.py --data-only
```

This command reads the retained compressed trials and corrected audits, checks all 24 educational table rows and all seven conversational table rows, validates key transition counts and source checks, then writes `derived_results.json` and three SVG figures. It does not need local full packets or the LoCoMo source dataset. A mismatch raises an assertion rather than silently revising manuscript results.

Convert each SVG to PNG using `sharp` with density 240, preserving its view box. For example, from the paper directory in a Node environment that resolves `sharp`:

```javascript
const sharp = require('sharp');
for (const name of ['architecture', 'freshness', 'coverage']) {
  await sharp(`figures/${name}.svg`, { density: 240 })
    .png().toFile(`figures/${name}.png`);
}
```

The loop is intended inside an async function, or a compatible interactive Node context. Then build Word:

```bash
python docs/research/education-memory-v2-paper/build_paper.py --docx-only
```

The output is a single-column Letter review manuscript. It is not a publisher template. The Markdown source is authoritative for prose; changes require rebuilding Word and rechecking layout. The artifact remains editable; charts are insertion images with separate vector sources and data, not native Word chart objects.

## Reproduce experiments separately

Full evaluation requires the documented LearnFlow backend environment and the separately acquired hash-verified LoCoMo source. Follow `evals/education_memory_v2/README.md` and the frozen protocol, using new output directories. `results/formal-03/suite.json.jobs[].command` records exact executed commands, family/conversation partitions, budgets, variants, and repetitions. Do not overwrite formal-02, formal-03, or their audits.

To reconstruct the earlier failure-producing implementation, follow `evals/education_memory_v2/results/formal-02/SOURCE_RECONSTRUCTION.md` in an isolated checkout. The preserved patch has SHA-256 `f5072e66f3b2ba6ee4d25c6e8306d1c2d3f9a8b0c01a7d74739cee8bd5e4fb8a`. Verify source hashes before running. Compare both implementations with the corrected v2 temporal audit; the retained initial freshness audit has known defects and is not used for the paper's numbers.

## Bibliographic verification

References were checked on 9 September 2026 against ACL Anthology, NeurIPS/ICLR proceedings, author arXiv records, Springer, the BM25 publisher result, and the W3C original note. The cited preprint versions of MemGPT, Generative Agents, and A-MEM are explicitly identified as preprints; the paper does not borrow or compare their published performance numbers. AMemGym's author arXiv record identifies acceptance to ICLR 2026; this draft cites the checked arXiv version. Its first author is retained as the full displayed name “Cheng Jiayang” to avoid guessing a name-order abbreviation. Corbett and Anderson's year follows the publisher's issue date of 1994, despite a later revision date. LoCoMo page range is 13851–13870.

Primary links appear in the manuscript references and the BibTeX file. Related work is a targeted comparison of relevant mechanisms, not a systematic literature review or an exhaustive September 2026 state-of-the-art survey. No unsupported cross-paper superiority is claimed.

## Publication boundaries

Responsible authors must supply identities, affiliations, contributions, funding, conflicts, institutional ethics determinations as applicable, and final AI-use disclosure. The repository is identifiable; this draft is not anonymized for double-blind review. No publisher submission or communication with an editor is part of this work. Open repository access is not asserted to grant unrestricted licensing rights for every component.
