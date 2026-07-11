"""Streamlit entry point for the AP Resolution Agent demo."""

from pathlib import Path
from uuid import uuid4

import streamlit as st

from storage import initialize_runtime_database
from pipeline import (
    ExtractionError,
    MappingError,
    PDFValidationError,
    build_source_catalogue,
    extract_invoice,
    map_invoice,
    validate_and_store_pdf,
)


FIXTURE_DIR = Path(__file__).resolve().parent / "data" / "fixtures"

st.set_page_config(page_title="AP Resolution Agent", page_icon="🧾", layout="wide")
initialize_runtime_database()

st.markdown(
    """
    <style>
    .stApp { background: #f5f6f2; color: #17211b; }
    .block-container { max-width: 1320px; padding-top: 2.2rem; }
    [data-testid="stVerticalBlockBorderWrapper"] { background: white; }
    .ap-eyebrow { color:#1f7a4d; font-size:.75rem; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
    .ap-subtitle { color:#68726b; margin-top:-.6rem; }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown(
    '<div class="ap-eyebrow">Accounts payable command center</div>',
    unsafe_allow_html=True,
)
st.title("Invoices, decisions, and evidence")
st.markdown(
    '<p class="ap-subtitle">Upload an invoice and follow every evidence-backed processing stage in one place.</p>',
    unsafe_allow_html=True,
)

input_column, activity_column = st.columns([1.55, 0.85], gap="large")

with input_column:
    with st.container(border=True):
        st.subheader("Process a new invoice")
        fixture_names = [
            "Upload your own PDF",
            *(path.name for path in sorted(FIXTURE_DIR.glob("*.pdf"))),
        ]
        fixture_name = st.selectbox("Try a fixture", fixture_names)
        uploaded_pdf = st.file_uploader(
            "Or drop an invoice PDF here",
            type=["pdf"],
            help="Maximum 10 MiB and 10 pages.",
        )
        st.caption(
            "Privacy: PDFs go to Azure Document Intelligence. Extracted evidence goes to OpenAI. Python owns the final accounting decision."
        )

        if st.button(
            "Run invoice",
            type="primary",
            use_container_width=True,
            disabled=fixture_name == fixture_names[0] and uploaded_pdf is None,
        ):
            content = (
                uploaded_pdf.getvalue()
                if uploaded_pdf is not None
                else (FIXTURE_DIR / fixture_name).read_bytes()
            )
            with st.status("Validating PDF", expanded=True) as status:
                try:
                    validate_and_store_pdf(content, str(uuid4()))
                    st.write("PDF validated")
                    status.update(label="Extracting invoice evidence")
                    extraction = extract_invoice(content)
                    sources = build_source_catalogue(extraction)
                    st.write(f"Extracted {len(sources)} evidence references")
                    status.update(label="Mapping invoice fields")
                    mapping = map_invoice(sources)
                except PDFValidationError as error:
                    status.update(label=str(error), state="error")
                    st.error(
                        f"{error.decision} / {error.execution} / {error.reason_code} — {error}"
                    )
                except (ExtractionError, MappingError) as error:
                    status.update(label="Invoice processing stopped", state="error")
                    st.error(f"NEEDS_REVIEW / BLOCKED / {error.reason_code} — {error}")
                else:
                    status.update(label="Invoice mapped", state="complete")
                    st.success("Invoice evidence extracted and mapped.")
                    with st.expander("Inspect mapped evidence", expanded=True):
                        st.json(mapping.model_dump())

    with st.container(border=True):
        st.subheader("Recent runs")
        st.caption(
            "No persisted runs yet. History will appear after posting is implemented."
        )

with activity_column:
    with st.container(border=True):
        st.subheader("How a run is decided")
        st.markdown(
            """
            1. **Validate** the uploaded PDF
            2. **Extract** observed Azure evidence
            3. **Map** fields by source ID with OpenAI
            4. **Upcoming:** check PO, price, quantity, and receipts
            5. **Upcoming:** post once or explain why review is needed
            """
        )
    with st.container(border=True):
        st.subheader("Responsibility split")
        st.markdown(
            "**Azure** observes the document.  \n"
            "**OpenAI** selects evidence IDs.  \n"
            "**Python** makes deterministic accounting decisions."
        )
