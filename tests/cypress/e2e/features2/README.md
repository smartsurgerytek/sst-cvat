## Review Controls Cypress Tests

These tests cover the review workspace controls for:

- Finish button modal behavior
- Raw compare toggle state/event
- Issue mask creation flow

### What is validated

- Finish button opens the confirmation modal, shows expected text, and can be canceled
- Raw compare button toggles active state and emits `cvat.rawCompareToggle` with correct `detail.active`
- Issue mask tool enables brush UI, finishes via `m`, creates an issue
  from a drawn mask, closes the mask tools after submit, converts the
  issue into a mask annotation, validates edit/save, and persists after
  reload
- Non-mask issues (e.g., rectangle issues) do not show the "Convert to mask" action

### Specs

- `tests/cypress/e2e/features2/review_controls_finish_button.js`
- `tests/cypress/e2e/features2/review_controls_raw_compare.js`
- `tests/cypress/e2e/features2/review_controls_issue_mask.js`

### Prerequisites

Make sure the CVAT instance is running and a test user exists, then install test dependencies.

Start CVAT (from repo root):

```bash
docker compose \
          -f docker-compose.yml \
          -f docker-compose.dev.yml \
          -f components/serverless/docker-compose.serverless.yml \
          -f tests/docker-compose.minio.yml \
          -f tests/docker-compose.file_share.yml up -d
```

Create test user (admin):

```bash
docker exec -i cvat_server /bin/bash -c "echo \"from django.contrib.auth.models import User; User.objects.create_superuser('admin', 'admin@localhost.company', '12qwaszx')\" | python3 ~/manage.py shell"
```

Install test dependencies:

```bash
cd /home/chunwei/cvat/tests
yarn --immutable
```

If Cypress is not installed:

```bash
npx cypress install
```

### Run all three specs

```bash
yarn run cypress:run:chrome --spec "cypress/e2e/features2/review_controls_finish_button.js,cypress/e2e/features2/review_controls_raw_compare.js,cypress/e2e/features2/review_controls_issue_mask.js"
```

### Run a single spec

```bash
yarn run cypress:run:chrome --spec cypress/e2e/features2/review_controls_issue_mask.js
```

### Notes

- The coverage message "Cannot find coverage file" is expected unless you instrument the code.
