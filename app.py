"""Streamlit entry point for the AP Resolution Agent demo."""

from pathlib import Path

import streamlit as st

from storage import initialize_runtime_database


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
        with st.status("Preparing invoice", expanded=True) as status:
            st.write("Invoice selected")
            status.update(label="Ready for extraction", state="complete")

with dashboard_tab:
    st.info("Processed invoice history will appear here.")
