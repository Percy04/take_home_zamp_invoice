# Deployment

Deploy the repository as one Docker web service using `render.yaml`. The compiled React client and Express API are same-origin. SQLite is stored at `/var/data/zamp/runtime.sqlite` on the attached persistent disk; do not deploy this design to an ephemeral or horizontally scaled filesystem.

Set the Azure credentials, `MAPPING_PROVIDER=openai` or `gemini`, and only the selected mapper's API key in Render before deploying. Production startup rejects incomplete provider configuration, and every uploaded invoice uses the live providers.

Verify after deployment: `/api/health`, a live uploaded invoice that immediately returns `PROCESSING`, polling to its final run state, PDF preview, refresh recovery, and one posted ledger row after an idempotent upload retry and repeated unified review call.
