# Deployment

Deploy the repository as one Docker web service using `render.yaml`. The compiled React client and Express API are same-origin. SQLite is stored at `/var/data/zamp/runtime.sqlite` on the attached persistent disk; do not deploy this design to an ephemeral or horizontally scaled filesystem.

For a no-credit demo, keep `PROVIDER_MODE=recorded`. For live processing, set `PROVIDER_MODE=live`, Azure credentials, `MAPPING_PROVIDER=openai` or `gemini`, and only the selected mapper's API key. Production startup rejects incomplete live configuration.

Verify after deployment: `/api/health`, reset, all nine fixtures, PDF preview, refresh recovery, and one posted ledger row after repeated process/confirmation calls.
