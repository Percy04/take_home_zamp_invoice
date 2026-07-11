"""Streamlit entry point for the AP Resolution Agent demo."""

from pathlib import Path
from uuid import uuid4

import streamlit as st

from storage import initialize_runtime_database
from pipeline import PDFValidationError, validate_and_store_pdf


FIXTURE_DIR = Path(__file__).resolve().parent / "data" / "fixtures"

st.set_page_config(page_title="AP Resolution Agent", page_icon="🧾", layout="wide")
initialize_runtime_database()

st.title("AP Resolution Agent")
st.caption("Single-user resettable demo")

process_tab, dashboard_tab = st.tabs(["Process Invoice", "Dashboard & Review"])

with process_tab:
    fixture_names = [
        "Upload your own PDF",
        *(path.name for path in sorted(FIXTURE_DIR.glob("*.pdf"))),
    ]
    fixture_name = st.selectbox("Try a fixture", fixture_names)
    uploaded_pdf = st.file_uploader("Or upload an invoice", type=["pdf"])

    if st.button(
        "Run",
        type="primary",
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
            except PDFValidationError as error:
                status.update(label=str(error), state="error")
                st.error(str(error))
            else:
                status.update(label="PDF ready", state="complete")
                st.success("PDF validated and stored safely.")

with dashboard_tab:
    st.info("Processed invoice history will appear here.")
