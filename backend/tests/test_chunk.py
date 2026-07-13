from app.pipeline.chunk import chunk_blocks
from app.pipeline.parse import Block


def test_single_small_paragraph_becomes_one_chunk():
    blocks = [Block(type="paragraph", text="Short paragraph.", page=1)]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    assert len(chunks) == 1
    c = chunks[0]
    assert c.text == "Short paragraph."
    assert c.section_path == "Body"
    assert c.page_start == 1
    assert c.page_end == 1
    assert c.text_for_embedding == "[doc.pdf > Body, p.1]\nShort paragraph."
    assert c.sparse_terms == ["short", "paragraph"]


def test_heading_sets_section_path_and_flushes_prior_accumulator():
    blocks = [
        Block(type="paragraph", text="Intro text before any heading.", page=1),
        Block(type="heading", text="Scope of Work", level=1, page=1),
        Block(type="paragraph", text="Details under the heading.", page=2),
    ]
    chunks = chunk_blocks(blocks=blocks, filename="rfp.pdf")

    assert len(chunks) == 2
    assert chunks[0].section_path == "Body"
    assert chunks[0].page_start == 1
    assert chunks[1].section_path == "Scope of Work"
    assert chunks[1].page_start == 2
    assert chunks[1].page_end == 2


def test_nested_headings_pop_stack_on_same_or_shallower_level():
    blocks = [
        Block(type="heading", text="Section A", level=1, page=1),
        Block(type="heading", text="Sub A.1", level=2, page=1),
        Block(type="paragraph", text="Deep content.", page=1),
        Block(type="heading", text="Section B", level=1, page=2),
        Block(type="paragraph", text="Sibling content.", page=2),
    ]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    assert len(chunks) == 2
    assert chunks[0].section_path == "Section A > Sub A.1"
    assert chunks[1].section_path == "Section B"


def test_list_items_are_grouped_and_bulleted():
    blocks = [
        Block(type="list_item", text="First item", page=1),
        Block(type="list_item", text="Second item", page=1),
        Block(type="list_item", text="Third item", page=1),
    ]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    assert len(chunks) == 1
    assert chunks[0].text == "• First item\n• Second item\n• Third item"


def test_page_range_spans_multiple_pages_within_one_chunk():
    blocks = [
        Block(type="paragraph", text="Page one content.", page=1),
        Block(type="paragraph", text="Page two content.", page=2),
        Block(type="paragraph", text="Page three content.", page=3),
    ]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    assert len(chunks) == 1
    assert chunks[0].page_start == 1
    assert chunks[0].page_end == 3


def test_target_max_forces_flush_into_multiple_chunks():
    # Each paragraph is ~600 chars => ~150 tokens. TARGET_MIN=400, TARGET_MAX=600
    # tokens. Five of these (750 tokens) must split into 2+ chunks, and no
    # chunk should exceed 1.5x TARGET_MAX (900 tokens).
    long_para = "word " * 150  # ~750 chars => ~188 tokens
    blocks = [
        Block(type="paragraph", text=f"{long_para}{i}", page=1) for i in range(6)
    ]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    assert len(chunks) >= 2
    for c in chunks:
        approx_tokens = len(c.text) / 4
        assert approx_tokens <= 600 * 1.5 + 50  # small slack for the final segment push


def test_sparse_terms_filter_stopwords_and_short_tokens_and_dedupe():
    blocks = [
        Block(
            type="paragraph",
            text="The vendor shall provide the vendor with a compliant compliant solution and it must be scalable.",
            page=1,
        )
    ]
    chunks = chunk_blocks(blocks=blocks, filename="doc.pdf")

    terms = chunks[0].sparse_terms
    # stopwords like "the", "with", "and", "it", "must", "shall" excluded
    for stop in ("the", "with", "and", "it", "must", "shall", "be", "must"):
        assert stop not in terms
    # deduped
    assert terms.count("vendor") == 1
    assert terms.count("compliant") == 1
    # meaningful terms present
    assert "vendor" in terms
    assert "compliant" in terms
    assert "solution" in terms
    assert "scalable" in terms


def test_empty_blocks_produce_no_chunks():
    assert chunk_blocks(blocks=[], filename="doc.pdf") == []


def test_multiple_documents_worth_of_blocks_produce_realistic_chunk_count():
    blocks = [Block(type="heading", text="Requirements", level=1, page=1)]
    for i in range(40):
        blocks.append(
            Block(
                type="paragraph",
                text=f"Requirement number {i} describes a mandatory capability the vendor must deliver as part of the proposed solution architecture.",
                page=(i // 10) + 1,
            )
        )
    chunks = chunk_blocks(blocks=blocks, filename="rfp.pdf")

    assert len(chunks) >= 2
    assert all(c.section_path == "Requirements" for c in chunks)
    assert all(c.sparse_terms for c in chunks)
