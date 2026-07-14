# Deployment

Deploy the repository as one Docker web service using `render.yaml`. The compiled React client and Express API are same-origin. SQLite is stored at `/var/data/zamp/runtime.sqlite` on the attached persistent disk; do not deploy this design to an ephemeral or horizontally scaled filesystem.

The Render blueprint runs `PROVIDER_MODE=live`. Set the Azure credentials, `MAPPING_PROVIDER=openai` or `gemini`, and only the selected mapper's API key in Render before deploying; production startup rejects recorded mode and incomplete live configuration. Keep recorded mode for local offline development and automated tests only.

Verify after deployment: `/api/health`, a live uploaded invoice, PDF preview, refresh recovery, and one posted ledger row after repeated process/confirmation calls.
